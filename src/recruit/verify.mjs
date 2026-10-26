// 来源校验 v2（#46）：按源适配的复核策略。
// 现状：verify 对所有源一律 fetchText(详情页) + 标题子串，SPA/共用列表 URL 的源被批量误标「来源页面已变化」。
// 这里集中定义每个源的校验方式：
//   - 默认（详情页字符串匹配）：抓详情页，正文含标题 = 有效；否则区分 JS 壳 / 页面变化 / 真失效。
//   - list-json：swjtu/sufe/sicau/swpu-jobfair 的详情页是 JS 渲染，改走各自 JSON 列表接口，按事件 URL 匹配。
//   - list-level：uestc 多场共用一个列表 URL（无独立详情 URL），只能做列表级复核。
// 失败原因（写入 setVerified 的 notes）互不混淆：
//   page_changed 页面变化 / js_shell JS 壳无法字符串校验 / no_detail_url 无独立详情 URL /
//   gone 确认不存在（仅 404/410） / transient_error 暂时不可访问（超时/429/5xx/网络/DNS，可重试）。
import {fetchText as defaultFetchText} from './fetch.mjs';
import {htmlToText} from './collect.mjs';

export const VERIFY_CATEGORY = {
  OK: 'ok',
  PAGE_CHANGED: 'page_changed',
  JS_SHELL: 'js_shell',
  NO_DETAIL_URL: 'no_detail_url',
  GONE: 'gone',
  TRANSIENT_ERROR: 'transient_error'
};

const REASON = {
  ok_detail: '来源页面仍包含该活动',
  ok_list: '来源接口仍包含该活动',
  ok_no_detail: '无独立详情 URL，列表级复核仍包含该活动',
  page_changed: '来源页面已变化：未找到该活动',
  js_shell: '详情页为 JS 渲染，无法字符串校验，请用浏览器人工确认',
  no_detail_url: '无独立详情 URL，列表级复核未找到该活动',
  transient_error: '来源暂时无法访问（可重试）'
};

// 只有 404/410 能确认「活动已不存在」；超时、429、5xx、DNS/网络错误都不能当 GONE。
function failureOutcome(res) {
  const status = Number(res?.status) || 0;
  if (status === 404 || status === 410) {
    return {ok: false, category: VERIFY_CATEGORY.GONE, retryable: false, reason: '来源链接已失效' + (res?.message ? '：' + res.message : '')};
  }
  const detail = res?.message || res?.reason || '';
  return {ok: false, category: VERIFY_CATEGORY.TRANSIENT_ERROR, retryable: true, reason: REASON.transient_error + (detail ? '：' + detail : '')};
}

// 按源适配的列表级校验配置；未列出的源走默认详情页策略。
const LIST_VERIFY = {
  'swjtu-xjh': {
    kind: 'list-json',
    build(source, event) {
      const date = String(event.startAt || '').slice(0, 10);
      return {url: source.listUrl, body: 'date=' + date};
    }
  },
  'sufe-xjh': {kind: 'list-json'},
  'sicau-xjh': {kind: 'list-json'},
  'swpu-jobfair': {kind: 'list-json'},
  'uestc-xjh': {
    kind: 'list-level',
    build(_source, event) {
      const month = String(event.startAt || '').slice(0, 7);
      return {url: 'https://jiuye.uestc.edu.cn/career/api/home/calendar?month=' + month};
    }
  }
};

function titleHit(title) {
  return String(title || '').replace(/\s+/g, '').slice(0, 12);
}

// 从详情/列表 URL 里提取稳定键：忽略 enid/postid 等易漂移参数，只看 id/fair_id 或纯路径。
function urlKey(url) {
  try {
    const u = new URL(String(url));
    const id = u.searchParams.get('id') || u.searchParams.get('fair_id');
    if (id) return u.origin + u.pathname + '?id=' + id;
    return u.origin + u.pathname;
  } catch { return String(url || ''); }
}

function requestBody(source) {
  const body = source.request?.body;
  return typeof body === 'function' ? body() : body;
}

// 用源自己的 JSON 接口取回当前列表项（对多页源翻页；失败返回 {ok:false}）。
async function fetchListItems(source, event, spec, fetchText) {
  const pages = source.pageUrl && !spec.build ? Math.min(source.maxPages || 1, 5) : 1;
  const items = [];
  for (let p = 1; p <= pages; p++) {
    const req = spec.build
      ? spec.build(source, event)
      : {url: source.pageUrl ? source.pageUrl(p) : source.listUrl};
    const method = source.request?.method || 'GET';
    const body = spec.build ? req.body : requestBody(source);
    const headers = {...(source.mode === 'json' ? {referer: source.listUrl} : {}), ...(source.request?.headers || {})};
    const res = await fetchText(req.url, {method, headers, body, timeout: 15000, retries: 0});
    if (!res.ok) return {ok: false, res};
    let json;
    try { json = JSON.parse(res.text); } catch { return {ok: false, res, reason: 'not_json'}; }
    if (json.code && json.code !== 200 && !(source.acceptCode || []).map(Number).includes(Number(json.code))) {
      if (p === 1) return {ok: false, res, reason: 'code_' + json.code};
      break;
    }
    const pageItems = source.parseList('', source, json) || [];
    items.push(...pageItems);
    if (!pageItems.length || (json.totalPage && p >= Number(json.totalPage))) break;
  }
  return {ok: true, items};
}

function matchEvent(event, items, spec) {
  const hit = titleHit(event.title);
  return items.some(item => spec.kind === 'list-level'
    ? (hit.length >= 4 && titleHit(item.title).includes(hit))
    : (item.url && urlKey(item.url) === urlKey(event.sourceUrl)));
}

async function verifyList(source, event, spec, fetchText) {
  const got = await fetchListItems(source, event, spec, fetchText);
  if (!got.ok) {
    if (got.res) return failureOutcome(got.res);
    return {ok: false, category: VERIFY_CATEGORY.PAGE_CHANGED, reason: REASON.page_changed};
  }
  if (matchEvent(event, got.items, spec)) {
    const reason = spec.kind === 'list-level' ? REASON.ok_no_detail : REASON.ok_list;
    return {ok: true, category: VERIFY_CATEGORY.OK, reason};
  }
  if (spec.kind === 'list-level') {
    return {ok: false, category: VERIFY_CATEGORY.NO_DETAIL_URL, reason: REASON.no_detail_url};
  }
  return {ok: false, category: VERIFY_CATEGORY.PAGE_CHANGED, reason: REASON.page_changed};
}

async function verifyDetail(source, event, fetchText) {
  const res = await fetchText(event.sourceUrl, {timeout: 15000, retries: 0});
  if (!res.ok) return failureOutcome(res);
  const text = htmlToText(res.text);
  const hit = titleHit(event.title);
  if (hit.length >= 4 && text.replace(/\s+/g, '').includes(hit)) {
    return {ok: true, category: VERIFY_CATEGORY.OK, reason: REASON.ok_detail};
  }
  // 详情页是前端渲染的 JS 壳时，正文几乎没有可见文字，无法字符串校验，不能误判为「页面变化」。
  if (text.replace(/\s+/g, '').length < 60) {
    return {ok: false, category: VERIFY_CATEGORY.JS_SHELL, reason: REASON.js_shell};
  }
  return {ok: false, category: VERIFY_CATEGORY.PAGE_CHANGED, reason: REASON.page_changed};
}

// 校验单条活动：source 是源对象（含 parseList），event 是库里的活动行。deps.fetchText 可注入便于测试。
export async function verifyEvent(source, event, deps = {}) {
  const fetchText = deps.fetchText || defaultFetchText;
  const spec = LIST_VERIFY[source.id];
  if (spec) return verifyList(source, event, spec, fetchText);
  return verifyDetail(source, event, fetchText);
}
