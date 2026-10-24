// 采集编排：抓列表 → 解析 → 按需抓详情 → 去重入库 → 记录运行结果。
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fetchText} from './fetch.mjs';
import {SOURCES, sourceById, guessKind, guessCompany, normalizeCity} from './sources.mjs';
import {browserText, parseRenderedText} from './browser.mjs';
import {RecruitStore} from './store.mjs';

export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function eventId(event) {
  return createHash('sha1')
    .update([event.school || '', event.title || '', event.startAt || '', event.venue || ''].join('|'))
    .digest('hex').slice(0, 24);
}

function normalize(item, source) {
  const title = String(item.title || '').trim();
  const startAt = String(item.startAt || '').trim();
  if (!title || !startAt) return null;
  const kind = item.kind || guessKind(title, source.kind);
  const event = {
    school: source.school,
    city: normalizeCity(item.city || source.city, source.city),
    kind,
    title: title.slice(0, 200),
    company: (item.company || (kind === '宣讲会' ? guessCompany(title) : '')).slice(0, 120),
    startAt,
    endAt: item.endAt || '',
    venue: item.venue || '',
    address: item.address || '',
    industry: item.industry || '',
    companySize: item.companySize || '',
    positions: item.positions || '',
    requirements: item.requirements || '',
    applyMode: item.applyMode || '',
    applyUrl: item.applyUrl || '',
    sourceUrl: item.url || source.listUrl,
    publishedAt: item.publishedAt || '',
    fetchedAt: new Date().toISOString(),
    confidence: item.confidence ?? 0.55,
    rawText: item.rawText || '',
    notes: item.notes || '',
    sourceId: source.id
  };
  event.id = eventId(event);
  return event;
}

function scoreConfidence(event) {
  let c = 0.55;
  if (event.venue) c += 0.15;
  if (event.endAt) c += 0.1;
  if (event.company) c += 0.05;
  if (event.notes.includes('详情')) c += 0.1;
  return Math.min(0.95, Number(c.toFixed(2)));
}

export async function collectSource(sourceOrId, {dir, limit = 20, detailLimit = 8, onLog = () => {}, persist = true} = {}) {
  const source = typeof sourceOrId === 'string' ? sourceById(sourceOrId) : sourceOrId;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const store = persist ? RecruitStore.open(join(dir, 'recruit.db')) : null;
  const result = {id: source.id, name: source.name, status: 'ok', fetched: 0, created: 0, updated: 0, message: '', durationMs: 0};
  try {
    if (!source.enabled) {
      result.status = 'disabled';
      result.message = source.note || '该信息源尚未接入';
      return result;
    }
    onLog?.({source: source.id, text: '开始采集：' + source.name});

    let items = [];
    if (source.mode === 'browser') {
      const {text, title} = await browserText(source.listUrl);
      if (store) store.saveRaw({url: source.listUrl, sourceId: source.id, title, text});
      items = parseRenderedText(text, source);
    } else {
      const res = await fetchText(source.listUrl, {method: source.request?.method || 'GET', headers: {...(source.mode === 'json' ? {referer: source.listUrl} : {}), ...source.request?.headers}, body: source.request?.body});
      if (!res.ok) {
        result.status = res.reason === 'robots_disallowed' ? 'disallowed' : res.reason === 'blocked' ? 'blocked' : 'error';
        result.message = res.message;
        return result;
      }
      if (store) store.saveRaw({url: source.listUrl, sourceId: source.id, title: source.name, text: res.text.slice(0, 120000)});
      if (source.mode === 'json') {
        const pages = source.pageUrl ? Math.min(source.maxPages || 1, 5) : 1;
        for (let p = 1; p <= pages; p++) {
          const pageUrl = source.pageUrl ? source.pageUrl(p) : source.listUrl;
          const pageRes = p === 1 ? res : await fetchText(pageUrl, {method: source.request?.method || 'GET', headers: {referer: source.listUrl, ...source.request?.headers}, body: source.request?.body});
          if (!pageRes.ok) break;
          let json;
          try { json = JSON.parse(pageRes.text); } catch { throw new Error('接口返回的不是 JSON，可能被登录页或验证码拦截'); }
          if (json.code && json.code !== 200) {
            if (p === 1) throw new Error('接口返回 code=' + json.code + ' ' + (json.message || ''));
            break;
          }
          const pageItems = source.parseList(pageRes.text, source, json);
          items.push(...pageItems);
          if (!pageItems.length || items.length >= limit) break;
        }
      } else {
        items = source.parseList(res.text, source);
      }
    }
    items = items.slice(0, limit);
    result.fetched = items.length;
    onLog?.({source: source.id, text: `列表解析到 ${items.length} 条`});

    // 详情页补充（只对缺地点/缺结束时间的条目，控制请求量）
    if (source.detail && source.parseDetail) {
      let done = 0;
      for (const item of items) {
        if (done >= detailLimit) break;
        if (item.venue && item.endAt) continue;
        try {
          const res = await fetchText(item.url, {timeout: 15000});
          if (!res.ok) continue;
          const text = htmlToText(res.text);
          const extra = source.parseDetail(text, item) || {};
          if (extra.venue && !item.venue) item.venue = extra.venue;
          if (extra.date && !item.startAt) item.startAt = extra.date + 'T09:00:00+08:00';
          if (extra.startTime) item.startAt = (extra.date || item.startAt.slice(0, 10)) + 'T' + extra.startTime + ':00+08:00';
          if (extra.endTime) item.endAt = (extra.date || item.startAt.slice(0, 10)) + 'T' + extra.endTime + ':00+08:00';
          item.notes = [item.notes, '详情页已核对'].filter(Boolean).join('；');
          item.rawText = text.slice(0, 4000);
          done++;
        } catch { /* 单条详情失败不影响整批 */ }
      }
    }

    for (const item of items) {
      const event = normalize(item, source);
      if (!event) continue;
      event.confidence = scoreConfidence(event);
      if (store) {
        const action = store.upsertEvent(event);
        if (action === 'created') result.created++; else result.updated++;
      } else result.created++;
    }
    if (!items.length) { result.status = 'empty'; result.message = '页面可访问，但没有解析到活动；可能需要浏览器模式或适配选择器。'; }
  } catch (e) {
    result.status = 'error';
    result.message = e.message;
  } finally {
    result.durationMs = Date.now() - t0;
    if (store) {
      try {
        store.markSource(source.id, {status: result.status, error: result.message, count: result.created});
        store.recordRun({id: randomUUID(), sourceId: source.id, startedAt, finishedAt: new Date().toISOString(), status: result.status, fetched: result.fetched, created: result.created, updated: result.updated, message: result.message});
      } catch { /* 记录失败不掩盖采集结果 */ }
      store.close();
    }
    onLog?.({source: source.id, text: `${result.status}：新增 ${result.created}，更新 ${result.updated}${result.message ? '；' + result.message : ''}`});
  }
  return result;
}

export async function runCollection({dir, sourceIds, limit = 20, onLog}) {
  const ids = sourceIds?.length ? sourceIds : SOURCES.filter(s => s.enabled).map(s => s.id);
  const results = [];
  for (const id of ids) {
    let source;
    try { source = sourceById(id); } catch (e) { results.push({id, status: 'unknown', message: e.message}); continue; }
    results.push(await collectSource(source, {dir, limit, onLog}));
  }
  return {results, totals: {
    sources: results.length,
    fetched: results.reduce((a, r) => a + (r.fetched || 0), 0),
    created: results.reduce((a, r) => a + (r.created || 0), 0),
    updated: results.reduce((a, r) => a + (r.updated || 0), 0),
    failed: results.filter(r => ['error', 'blocked', 'disallowed'].includes(r.status)).length
  }};
}
