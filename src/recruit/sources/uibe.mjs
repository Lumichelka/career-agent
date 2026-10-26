// 对外经济贸易大学就业创业指导中心：招聘活动（宣讲会）。
//
// 列表页 /front/channel.jspa?channelId=766&parentId=625 由站点 JS 渲染：每页 20 条、共 202 页。
// 站点 robots.txt 明确 Disallow: /front/zp_query/，所以这里不直连查询接口；由应用内浏览器打开
// 公开列表页，读取该页自身已解密的查询结果（与用户点开页面看到的一致），再按页低频翻页。
// 详情页 /front/zph.jspa?tid=... 是静态 HTML，含单位、地点、时间与招聘说明正文。
import {createDecipheriv} from 'node:crypto';
import {guessKind, parseDateText, parseTimeRange, strip} from './common.mjs';

export const UIBE_ORIGIN = 'https://career.uibe.edu.cn';
export const UIBE_LIST_URL = UIBE_ORIGIN + '/front/channel.jspa?channelId=766&parentId=625';
const UIBE_DETAIL = tid => UIBE_ORIGIN + '/front/zph.jspa?tid=' + encodeURIComponent(String(tid));
// 站点公开页面 myAES.js 里的固定密钥；只用于读取公开列表页自己返回的数据。
const AES_KEY = 'abcdef0123456789';
const AES_IV = '0123456789abcdef';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function uibeDetailUrl(tid) {
  const value = String(tid ?? '').trim();
  return value ? UIBE_DETAIL(value) : '';
}

// 站点列表接口用 CryptoJS AES-CBC + ZeroPadding 加密；解密失败一律说明原因，不返回半截数据。
export function decryptUibePayload(ciphertext) {
  const clean = String(ciphertext ?? '').replace(/\s+/g, '');
  if (!clean) throw new Error('列表响应为空，无法解密');
  let bytes;
  try {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(AES_KEY, 'latin1'), Buffer.from(AES_IV, 'latin1'));
    decipher.setAutoPadding(false);
    bytes = Buffer.concat([decipher.update(Buffer.from(clean, 'base64')), decipher.final()]);
  } catch (error) {
    throw new Error('列表响应解密失败：' + error.message);
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end).toString('utf8');
  if (!text.trim()) throw new Error('列表响应解密后为空');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('列表响应解密后不是 JSON：' + error.message);
  }
}

export function parseUibePageMeta(json) {
  return {
    curPage: Number(json?.curPage) || 0,
    pageCount: Number(json?.pageCount) || 0,
    totalRecords: Number(json?.totalRecords) || 0
  };
}

// 毫秒时间戳按北京时间输出；没有值就留空，不用当前时间补齐。
function beijingIso(timestamp) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

export function parseUibeListJson(json, source = {}) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const out = [];
  for (const row of rows) {
    const title = strip(row?.title || row?.name);
    const startAt = beijingIso(row?.startTime);
    if (!title || !startAt) continue;
    const url = uibeDetailUrl(row?.tid);
    if (!url) continue;
    out.push({
      title,
      company: strip(row?.name),
      startAt,
      endAt: beijingIso(row?.endTime),
      venue: strip(row?.address),
      city: source.city || '北京',
      url,
      kind: guessKind(title, source.kind || '宣讲会')
    });
  }
  return out;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// 手动粘贴渲染后的列表页时用。页面只显示“10月27日”，没有年份；没有显式年份就不填开始时间。
export function parseUibeListHtml(html, source = {}, {year = ''} = {}) {
  const raw = String(html || '');
  const list = raw.match(/<ul[^>]*id=["']zph-list-content["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || '';
  const yearInPage = (raw.match(/\b(20\d{2})-\d{1,2}-\d{1,2}\b/) || [])[1] || '';
  const useYear = String(year || yearInPage || '').trim();
  const out = [];
  for (const match of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const li = match[1];
    const timeHtml = li.match(/<span[^>]*class=["'][^"']*create-time[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '';
    const link = li.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const title = strip(link[2]);
    const date = strip(timeHtml).match(/(\d{1,2})月\s*(\d{1,2})日/);
    if (!title || !date) continue;
    const times = parseTimeRange(strip(timeHtml));
    const day = useYear ? useYear + '-' + pad(date[1]) + '-' + pad(date[2]) : '';
    const noTimeNote = times?.[0] ? '' : '列表页没有具体时间，按 09:00 占位；请点开详情核对';
    let url = '';
    try {
      const resolved = new URL(link[1], UIBE_ORIGIN);
      url = resolved.origin === UIBE_ORIGIN ? resolved.href : '';
    } catch { /* 非 http 链接直接丢弃 */ }
    if (!url) continue;
    out.push({
      title,
      company: '',
      startAt: day ? day + 'T' + (times?.[0] || '09:00') + ':00+08:00' : '',
      endAt: day && times?.[1] ? day + 'T' + times[1] + ':00+08:00' : '',
      venue: strip(li.match(/<span[^>]*class=["'][^"']*region[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''),
      city: source.city || '北京',
      url,
      kind: guessKind(title, source.kind || '宣讲会'),
      notes: [day ? '' : '列表页没有年份，未填开始时间；请点开详情核对', day ? noTimeNote : ''].filter(Boolean).join('；')
    });
  }
  return out;
}

export function parseUibeDetail(text, _item = {}) {
  const all = String(text || '');
  // 只从“招聘单位”开始读，避免把页脚“办公地点”误当成活动地点。
  const contentStart = all.search(/招聘单位[：:]/);
  const content = contentStart >= 0 ? all.slice(contentStart) : all;
  const footerIndex = content.search(/\n(?:关注我们|友情链接|招生咨询|办公地点|当前位置)[：:]?/);
  const body = footerIndex >= 0 ? content.slice(0, footerIndex) : content;
  const field = label => {
    const match = body.match(new RegExp(label + '[：:]\\s*([^\\n]+)'));
    return match ? strip(match[1]) : '';
  };
  const company = field('招聘单位');
  const venue = field('地点');
  // “时间：2026-10-27”和“18:30 - 20:30”在转文本后可能分成两行，一起取。
  let timeText = '';
  const timeIndex = body.search(/时间[：:]/);
  if (timeIndex >= 0) {
    timeText = body.slice(timeIndex).split('\n').slice(0, 3).join(' ').replace(/^时间[：:]\s*/, '');
  }
  const date = parseDateText(timeText);
  const times = parseTimeRange(timeText);
  const bodyIndex = body.search(/招聘说明[：:]/);
  let rawText = '';
  if (bodyIndex >= 0) {
    rawText = body.slice(bodyIndex).replace(/^招聘说明[：:]\s*/, '');
    rawText = rawText.trim().slice(0, 4000);
  }
  const extra = {};
  if (company) extra.company = company;
  if (venue) extra.venue = venue;
  if (date) extra.date = date;
  if (times?.[0]) extra.startTime = times[0];
  if (times?.[1]) extra.endTime = times[1];
  if (rawText) extra.rawText = rawText;
  return extra;
}

// 返回 null 表示停止：空页、达到条数上限，或已经到最后一页。
export function nextUibePage({curPage = 0, pageCount = 0, fetched = 0, limit = 0, pageItems = 0} = {}) {
  if (!pageItems) return null;
  if (limit > 0 && fetched >= limit) return null;
  if (pageCount > 0 && curPage >= pageCount) return null;
  return curPage + 1;
}

// loadPage(pageNo) 返回已解密的列表 JSON；注入它是为了在不联网时验证分页边界。
export async function collectUibePages({loadPage, source = {}, limit = 20, onLog = () => {}, delayMs = 0, sleep: wait = sleep} = {}) {
  const max = Math.max(1, Number(limit) || 20);
  const items = [];
  const seen = new Set();
  let page = 1;
  let pages = 0;
  let pageCount = 0;
  let totalRecords = 0;
  let stopped = 'limit';
  while (items.length < max) {
    const json = await loadPage(page);
    pages++;
    if (!json || json.msg !== 'Y') {
      throw new Error('列表接口返回异常：msg=' + String(json?.msg ?? '空'));
    }
    const meta = parseUibePageMeta(json);
    if (meta.pageCount) pageCount = meta.pageCount;
    if (meta.totalRecords) totalRecords = meta.totalRecords;
    const pageItems = parseUibeListJson(json, source);
    onLog({source: source.id, text: '列表第 ' + page + ' 页：解析到 ' + pageItems.length + ' 条（共 ' + (meta.pageCount || '?') + ' 页）'});
    if (!pageItems.length) {
      stopped = 'empty';
      break;
    }
    for (const item of pageItems) {
      const key = item.url || item.title + '|' + item.startAt;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= max) break;
    }
    if (items.length >= max) {
      stopped = 'limit';
      break;
    }
    const next = nextUibePage({curPage: page, pageCount, fetched: items.length, limit: max, pageItems: pageItems.length});
    if (next == null) {
      stopped = pageCount > 0 && page >= pageCount ? 'boundary' : 'empty';
      break;
    }
    if (delayMs > 0) await wait(delayMs);
    page = next;
  }
  return {items: items.slice(0, max), pageCount, totalRecords, pages, stopped};
}

// 用应用内浏览器打开公开列表页；站点自己的脚本会请求并解密列表，这里只读取它的响应。
export async function fetchUibeList({source = {}, limit = 20, onLog = () => {}} = {}) {
  let chromium;
  try {
    ({chromium} = await import('playwright'));
  } catch (error) {
    throw new Error('浏览器模式不可用：Playwright 组件缺失（' + String(error.message).slice(0, 120) + '）');
  }
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
  } catch (error) {
    throw new Error('浏览器模式不可用：未找到 Microsoft Edge，或 Playwright 组件缺失（' + String(error.message).slice(0, 120) + '）');
  }
  try {
    const context = await browser.newContext({
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: {width: 1366, height: 900}
    });
    const page = await context.newPage();
    const isListApi = response => {
      try {
        return response.request().method() === 'POST' && response.url().includes('/front/zp_query/zphQuery.do');
      } catch { return false; }
    };
    const loadPage = async pageNo => {
      const response = page.waitForResponse(isListApi, {timeout: 30000});
      response.catch(() => {});
      try {
        if (pageNo === 1) {
          await page.goto(source.listUrl || UIBE_LIST_URL, {waitUntil: 'domcontentloaded', timeout: 30000});
        } else {
          const ok = await page.evaluate(number => {
            const input = document.querySelector('#curPage');
            if (!input || typeof window.loadData !== 'function') return false;
            input.value = String(number);
            window.loadData();
            return true;
          }, pageNo);
          if (!ok) throw new Error('列表页结构变化：找不到翻页控件（#curPage / loadData）。');
        }
        const cipher = await (await response).text();
        try {
          return decryptUibePayload(cipher);
        } catch (error) {
          throw new Error('列表接口返回无法解密（站点可能改版）：' + error.message);
        }
      } catch (error) {
        if (/timeout/i.test(String(error?.name || '') + ' ' + String(error?.message || ''))) {
          throw new Error('列表接口响应超时：站点可能改版或网络较慢。');
        }
        throw error;
      }
    };
    return await collectUibePages({loadPage, source, limit, onLog, delayMs: 1200});
  } finally {
    await browser.close().catch(() => {});
  }
}

export default {
  id: 'uibe-career',
  name: '对外经济贸易大学 · 就业创业指导中心',
  school: '对外经济贸易大学',
  city: '北京',
  category: '财经强校',
  channel: '就业信息网（招聘活动）',
  kind: '宣讲会',
  mode: 'browser',
  capabilities: {list: 'browser', detail: 'http', projects: 'none'},
  enabled: true,
  detail: 'http',
  detailAll: true,
  listUrl: UIBE_LIST_URL,
  sourceCheck: {enabled: true},
  note: '列表由站点 JS 渲染（每页 20 条、共 202 页），用应用内浏览器打开公开列表页读取站点已解密的数据；robots 禁止直连 /front/zp_query/，因此不直连查询接口。详情页静态可读，含单位/地点/时间/正文；解析不到字段就留空，不猜。',
  fallback: '手动 AI 兜底由 #58 接入；结构变化时也可用来源校对或手动导入。',
  parseList(input, source = {}, json = null) {
    if (json && typeof json === 'object') return parseUibeListJson(json, source);
    if (input && typeof input === 'object') return parseUibeListJson(input, source);
    return parseUibeListHtml(input, source);
  },
  parseDetail(text, item) {
    return parseUibeDetail(text, item);
  },
  fetchList({source = this, limit = 20, onLog = () => {}} = {}) {
    return fetchUibeList({source, limit, onLog});
  }
};
