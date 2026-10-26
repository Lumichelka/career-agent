// 招聘信息 API：列表、采集、核对、导出。挂在主服务的 /api/recruit/ 下。
// 这里只负责"算出结果"，写响应的细节交给 server.mjs。
import {join} from 'node:path';
import {RecruitStore} from './store.mjs';
import {SOURCES, REMOVED_SOURCES, sourceById} from './sources/index.mjs';
import {runCollection, htmlToText, normalize} from './collect.mjs';
import {parseManualInput} from './manual.mjs';
import {buildSchedule, toICS, toCSV, toMarkdown} from './schedule.mjs';
import {fetchText} from './fetch.mjs';
import {verifyEvent} from './verify.mjs';
import {parseRenderedText} from './browser.mjs';
import {WeChatStore} from '../wechat/store.mjs';
import {listPlatformJobs} from './platform-jobs-service.mjs';
import {sourceCheckEnabled} from '../source-check/config.mjs';
import {listPlaybooks, AI_FALLBACK_NOTE} from '../source-check/playbook.mjs';

const MAX_DAYS = 180;

function range(url) {
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
  const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + 'T23:59:59+08:00';
  return {from, to, days};
}

function withStore(dir, fn) {
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try { store.syncSources(SOURCES, REMOVED_SOURCES); return fn(store); } finally { store.close(); }
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
      const data = withStore(dir, store => ({sources: store.sourceStates(), runs: store.recentRuns(10), stats: store.stats(), manualReads: store.manualReads()}));
      // AI 兜底能力只由 playbook 决定：没有 playbook 的源就没有这个入口（不是自动采集，ADR 0003）。
      const playbooks = await listPlaybooks();
      const playbookFor = id => playbooks.find(pb => pb.id === id || pb.sourceIds.includes(id) || pb.aliases.includes(id)) || null;
      const aiFallback = playbook => ({available: Boolean(playbook), playbookId: playbook?.id || '', note: playbook ? AI_FALLBACK_NOTE : ''});
      const catalog = Object.fromEntries(SOURCES.map(s => {
        const playbook = playbookFor(s.id);
        return [s.id, {category: s.category, channel: s.channel, fallback: s.fallback || '', note: s.note || '', sourceCheck: sourceCheckEnabled(s), loginRequired: s.loginRequired === true, manualConfirm: s.manualConfirm === true, collectMode: s.collectMode || 'auto', capabilities: {...(s.capabilities || {list: s.mode, detail: s.detail ? 'http' : 'none', projects: typeof s.fetchProjects === 'function' ? 'custom' : 'none'}), manual: true}, aiFallback: aiFallback(playbook)}];
      }));
      let wechat = {accounts: [], stats: {accounts: 0, articles: 0}};
      try {
        const ws = WeChatStore.open(join(dir, 'wechat.db'));
        try {
          wechat = {
            accounts: ws.listAccounts().map(a => ({...a, sourceId: 'wechat:' + a.id, sourceType: 'wechat', enabled: true, aiFallback: aiFallback(playbookFor('wechat'))})),
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
    if (pathname === 'platform-jobs') {
      return {json: listPlatformJobs({
        dir,
        q: url.searchParams.get('q') || '',
        city: url.searchParams.get('city') || '',
        platform: url.searchParams.get('platform') || '',
        limit: Number(url.searchParams.get('limit')) || 50
      })};
    }
    if (pathname.startsWith('projects/')) {
      const id = pathname.split('/')[1];
      const data = withStore(dir, store => {
        const project = store.getProject(id);
        return project ? {project, event: store.getEvent(project.eventId)} : null;
      });
      return data ? {json: data} : {status: 404, json: {error: '招聘项目不存在'}};
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
    if (pathname === 'source-parse' || pathname === 'source-save') {
      let source;
      try { source = sourceById(String(body?.sourceId || '')); } catch { source = null; }
      if (!source) return {status: 400, json: {error: '未知信息源'}};
      const raw = String(body?.html || body?.text || '');
      if (raw.trim().length < 20) return {status: 400, json: {error: '请粘贴来源页 HTML 或正文'}};
      let json = null;
      if (source.mode === 'json') {
        try { json = JSON.parse(raw); } catch { return {status: 400, json: {error: '该源是 JSON 接口，请粘贴接口返回的 JSON'}}; }
      }
      let items = [];
      try {
        if (typeof source.parseList === 'function') items = source.parseList(source.mode === 'json' ? '' : raw, source, json) || [];
        if (!items.length && source.mode !== 'json') items = parseRenderedText(htmlToText(raw), source);
      } catch (e) { return {status: 400, json: {error: '解析失败：' + e.message}}; }
      const preview = [];
      for (const item of items.slice(0, 80)) {
        if (!item?.url && body?.url) item.url = String(body.url);
        const event = normalize(item, source);
        if (event) preview.push(event);
      }
      if (!preview.length) return {status: 400, json: {error: '没有解析到活动；请确认页面结构或换用正文手动导入'}};
      if (pathname === 'source-parse') {
        return {json: {ok: true, count: preview.length, preview: preview.slice(0, 20).map(e => ({title: e.title, startAt: e.startAt, venue: e.venue, url: e.sourceUrl}))}};
      }
      if (!body?.confirm) return {status: 400, json: {error: '需要确认后写入'}};
      let created = 0, updated = 0;
      withStore(dir, store => {
        for (const event of preview) {
          event.confidence = 0.62;
          event.notes = [event.notes, '手动粘贴来源页'].filter(Boolean).join('；');
          const action = store.upsertEvent(event);
          if (action === 'created') created++; else updated++;
        }
      });
      return {json: {ok: true, count: preview.length, created, updated}};
    }
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
      let source;
      try { source = sourceById(event.sourceId); } catch { source = {id: event.sourceId || 'unknown', listUrl: event.sourceUrl}; }
      const r = await verifyEvent(source, event);
      withStore(dir, store => store.setVerified(id, r.ok ? 1 : 0, r.reason));
      return {json: {ok: r.ok, category: r.category, message: r.ok ? '已复核：' + r.reason : r.reason}};
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
