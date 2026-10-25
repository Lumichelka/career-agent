// 招聘信息 API：列表、采集、核对、导出。挂在主服务的 /api/recruit/ 下。
// 这里只负责"算出结果"，写响应的细节交给 server.mjs。
import {join} from 'node:path';
import {RecruitStore} from './store.mjs';
import {SOURCES} from './sources/index.mjs';
import {runCollection, htmlToText, normalize} from './collect.mjs';
import {parseManualInput} from './manual.mjs';
import {buildSchedule, toICS, toCSV, toMarkdown} from './schedule.mjs';
import {fetchText} from './fetch.mjs';
import {WeChatStore} from '../wechat/store.mjs';

const MAX_DAYS = 180;

function range(url) {
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
  const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + 'T23:59:59+08:00';
  return {from, to, days};
}

function withStore(dir, fn) {
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try { store.syncSources(SOURCES); return fn(store); } finally { store.close(); }
}

async function concurrent(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at]); }
  }));
  return out;
}

export async function handleRecruit({method, pathname, url, body, dir}) {
  if (method === 'GET') {
    if (pathname === 'sources') {
      const data = withStore(dir, store => ({sources: store.sourceStates(), runs: store.recentRuns(10), stats: store.stats()}));
      const catalog = Object.fromEntries(SOURCES.map(s => [s.id, {category: s.category, channel: s.channel, fallback: s.fallback || '', note: s.note || '', capabilities: s.capabilities || {list: s.mode, detail: s.detail ? 'http' : 'none', projects: typeof s.fetchProjects === 'function' ? 'custom' : 'none'}}]));
      let wechat = {accounts: [], stats: {accounts: 0, articles: 0}};
      try {
        const ws = WeChatStore.open(join(dir, 'wechat.db'));
        try {
          wechat = {
            accounts: ws.listAccounts().map(a => ({...a, sourceId: 'wechat:' + a.id, sourceType: 'wechat', enabled: true})),
            stats: ws.stats()
          };
        } finally { ws.close(); }
      } catch { /* 公众号库尚未建立时不影响招聘来源 */ }
      return {json: {...data, catalog, wechat}};
    }
    if (pathname === 'events') {
      const {from, to, days} = range(url);
      const events = withStore(dir, store => store.listEvents({from, to, limit: 300, withProjects: true}));
      return {json: {events, days, from, to}};
    }
    if (pathname === 'calendar') {
      const requested = url.searchParams.get('month') || '';
      const month = /^\d{4}-\d{2}$/.test(requested) ? requested : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
      const [year, mon] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const from = `${month}-01T00:00:00+08:00`;
      const to = `${month}-${String(lastDay).padStart(2, '0')}T23:59:59+08:00`;
      const events = withStore(dir, store => store.listEvents({from, to, limit: 1000, withProjects: true}));
      const days = [];
      for (const e of events) {
        const date = e.startAt.slice(0, 10);
        let day = days.find(d => d.date === date);
        if (!day) { day = {date, events: []}; days.push(day); }
        day.events.push(e);
      }
      return {json: {month, days, stats: {events: events.length, projects: events.reduce((n, e) => n + (e.projects?.length || 0), 0)}}};
    }
    if (pathname === 'schedule') {
      const {from, to, days} = range(url);
      const events = withStore(dir, store => store.listEvents({from, to, limit: 300}));
      const schedule = buildSchedule(events);
      return {json: {schedule, markdown: toMarkdown(schedule, {title: `线下招聘时间安排表（未来 ${days} 天）`}), days}};
    }
    if (pathname === 'stats') return {json: withStore(dir, store => store.stats())};
    if (pathname === 'runs') return {json: {runs: withStore(dir, store => store.recentRuns(30))}};
    if (pathname.startsWith('export')) {
      const {from, to, days} = range(url);
      const events = withStore(dir, store => store.listEvents({from, to, limit: 500}));
      const format = (url.searchParams.get('format') || pathname.split('.').pop() || 'ics').toLowerCase();
      if (format === 'ics') return {file: {body: toICS(events), type: 'text/calendar; charset=utf-8', name: 'zhixiang-schedule.ics'}};
      if (format === 'csv') return {file: {body: toCSV(events), type: 'text/csv; charset=utf-8', name: 'zhixiang-schedule.csv'}};
      if (format === 'md') return {file: {body: toMarkdown(buildSchedule(events), {title: `线下招聘时间安排表（未来 ${days} 天）`}), type: 'text/markdown; charset=utf-8', name: 'zhixiang-schedule.md'}};
      return {status: 400, json: {error: '不支持的导出格式（ics/csv/md）'}};
    }
    return null;
  }

  if (method === 'POST') {
    if (pathname === 'projects/bulk') {
      const eventId = String(body?.eventId || '');
      const text = String(body?.text || '');
      if (!eventId) return {status: 400, json: {error: '缺少关联活动'}};
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 100);
      if (!lines.length) return {status: 400, json: {error: '请粘贴至少一行项目'}};
      try {
        const projects = withStore(dir, store => {
          const saved = [];
          for (const line of lines) {
            const parts = line.split(/\s*[|｜\t]\s*/);
            const company = parts[0] || '';
            const title = parts[1] || '';
            if (!company && !title) continue;
            saved.push(store.upsertProject({eventId, company, title, positions: parts[2] || '', applyMode: parts[3] || '', applyUrl: parts[4] || ''}));
          }
          return saved;
        });
        return {json: {ok: true, count: projects.length, projects}};
      } catch (e) {
        return {status: 400, json: {error: e.message}};
      }
    }
    if (pathname === 'projects') {
      try {
        const project = withStore(dir, store => store.upsertProject(body || {}));
        return {json: {ok: true, project}};
      } catch (e) {
        return {status: 400, json: {error: e.message}};
      }
    }
    if (pathname.startsWith('projects/') && pathname.endsWith('/delete')) {
      const id = pathname.split('/')[1];
      withStore(dir, store => store.deleteProject(id));
      return {json: {ok: true}};
    }
    if (pathname === 'manual/parse') {
      try {
        const parsed = await parseManualInput(body || {});
        return parsed.error ? {status: 400, json: parsed} : {json: parsed};
      } catch (e) {
        return {status: 500, json: {error: '解析失败：' + e.message}};
      }
    }

    if (pathname === 'manual/save') {
      const b = body || {};
      const source = {id: 'manual', school: String(b.school || '手动导入').slice(0, 60), city: b.city || '', kind: b.kind || '其他', listUrl: b.sourceUrl || ''};
      const event = normalize({...b, url: b.sourceUrl}, source);
      if (!event) return {status: 400, json: {error: '标题和开始时间必填'}};
      const saved = withStore(dir, store => {
        store.upsertEvent({...event, confidence: 0.7, notes: [event.notes, '手动确认'].filter(Boolean).join('；')});
        return store.getEvent(event.id);
      });
      return {json: {ok: true, event: saved}};
    }

    if (pathname === 'collect') {
      const sourceIds = Array.isArray(body?.sourceIds) ? body.sourceIds.filter(id => typeof id === 'string').slice(0, 12) : [];
      const limit = Math.min(50, Math.max(1, Number(body?.limit) || 20));
      const logs = [];
      const run = runCollection({dir, sourceIds, limit, onLog: e => logs.push(e.text)});
      const timeout = new Promise(resolve => setTimeout(() => resolve({results: [{id: '*', name: '超时', status: 'timeout', message: '采集超过 150 秒，已返回已完成部分'}], totals: {sources: 0, fetched: 0, created: 0, updated: 0, failed: 1}}), 150000));
      const result = await Promise.race([run, timeout]);
      return {json: {...result, logs, stats: withStore(dir, store => store.stats())}};
    }

    if (pathname === 'verify') {
      const id = String(body?.id || '');
      if (!/^[a-f0-9]{24}$/.test(id)) return {status: 400, json: {error: '无效记录'}};
      const event = withStore(dir, store => store.getEvent(id));
      if (!event) return {status: 404, json: {error: '没有这条记录'}};
      if (!event.sourceUrl) return {status: 400, json: {error: '这条记录没有来源链接，无法复核'}};
      const res = await fetchText(event.sourceUrl, {timeout: 20000, retries: 0});
      if (!res.ok) {
        withStore(dir, store => store.setVerified(id, 0, '复核失败：' + res.message));
        return {json: {ok: false, message: '来源链接打不开：' + res.message}};
      }
      const text = htmlToText(res.text).replace(/\s+/g, '');
      const hit = event.title.replace(/\s+/g, '').slice(0, 12);
      const ok = hit.length >= 4 && text.includes(hit);
      withStore(dir, store => store.setVerified(id, ok ? 1 : 0, ok ? '来源页面仍包含该活动' : '来源页面已变化，未找到活动标题'));
      return {json: {ok, message: ok ? '已复核：来源页面仍包含该活动' : '来源页面已变化，请点开链接人工确认'}};
    }

    if (pathname === 'probe') {
      const results = await concurrent(SOURCES, 4, async source => {
        const t = Date.now();
        const res = await fetchText(source.listUrl, {method: source.request?.method || 'GET', headers: source.request?.headers, body: source.request?.body, timeout: 12000, retries: 0});
        return {id: source.id, name: source.name, enabled: source.enabled, ok: res.ok, status: res.status, reason: res.reason || '', message: res.message || '', ms: Date.now() - t};
      });
      return {json: {results, at: new Date().toISOString()}};
    }

    return null;
  }

  return null;
}

