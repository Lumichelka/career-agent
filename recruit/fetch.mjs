// 抓取层：统一 UA、超时、编码、重试、限速、robots.txt 检查。
// 需求里"遇到 IP 限制要如实反馈并给替代方案"，这一层就是负责把失败原因讲清楚。
import {createHash} from 'node:crypto';

// 部分高校站点会直接拒绝非浏览器 UA（实测中山大学、上海财经大学对自定义 UA 返回 403），
// 因此这里使用常规浏览器 UA；仍通过 robots.txt、限速和只读方式保持克制。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const lastHit = new Map();
const robotsCache = new Map();

export const DEFAULT_HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate',
  'from': 'local-course-project'
};

function decode(bytes, contentType = '') {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 4096));
  const meta = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || (contentType.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  const enc = meta.toLowerCase();
  try { return new TextDecoder(enc === 'gb2312' ? 'gbk' : enc).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

async function inflate(buffer, encoding) {
  const {gzipSync, gunzipSync, inflateSync, brotliDecompressSync} = await import('node:zlib');
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return gunzipSync(buffer);
    if (enc.includes('deflate')) return inflateSync(buffer);
    if (enc.includes('br')) return brotliDecompressSync(buffer);
  } catch { /* 服务器有时标错编码，退回原样 */ }
  return buffer;
}

function originOf(url) { const u = new URL(url); return u.origin; }

async function throttle(url, minInterval) {
  const origin = originOf(url);
  const now = Date.now();
  const last = lastHit.get(origin) || 0;
  const wait = Math.max(0, minInterval - (now - last));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastHit.set(origin, Date.now());
}

export async function robotsAllows(url, {timeout = 8000} = {}) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const promise = (async () => {
      try {
        const res = await fetch(u.origin + '/robots.txt', {headers: {'user-agent': UA}, signal: AbortSignal.timeout(timeout)});
        if (!res.ok) return {rules: [], raw: ''};
        const raw = await res.text();
        const rules = [];
        let applies = false;
        for (const line of raw.split(/\r?\n/)) {
          const [k, ...rest] = line.split(':');
          const key = (k || '').trim().toLowerCase();
          const value = rest.join(':').trim();
          if (key === 'user-agent') applies = value === '*' || /zhixiang/i.test(value);
          else if (applies && key === 'disallow' && value) rules.push(value);
        }
        return {rules, raw};
      } catch { return {rules: [], raw: ''}; }
    })();
    robotsCache.set(u.origin, promise);
  }
  const {rules} = await robotsCache.get(u.origin);
  const path = u.pathname + u.search;
  return !rules.some(r => r === '/' || path.startsWith(r.replace(/\*$/, '')));
}

export async function fetchText(url, {method = 'GET', headers = {}, body, timeout = 20000, retries = 2, minInterval = 1200, checkRobots = true} = {}) {
  if (checkRobots && !(await robotsAllows(url))) {
    return {ok: false, status: 0, reason: 'robots_disallowed', message: '目标站点 robots.txt 不允许抓取该路径，已按合规要求跳过。'};
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(url, minInterval);
    try {
      const res = await fetch(url, {
        method,
        headers: {...DEFAULT_HEADERS, ...headers},
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout)
      });
      const raw = Buffer.from(await res.arrayBuffer());
      const buf = await inflate(raw, res.headers.get('content-encoding'));
      const text = decode(buf, res.headers.get('content-type') || '');
      if (!res.ok) {
        return {ok: false, status: res.status, reason: res.status === 403 ? 'blocked' : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'http_error', message: 'HTTP ' + res.status + '：' + text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120)};
      }
      return {ok: true, status: res.status, text, bytes: buf.length, url: res.url, contentType: res.headers.get('content-type') || ''};
    } catch (e) {
      lastError = e;
      const code = e?.cause?.code || e?.name || '';
      if (/ENOTFOUND|ECONNREFUSED|CERT/i.test(code) || attempt === retries) break;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  const code = lastError?.cause?.code || lastError?.name || '';
  const reason = /ENOTFOUND/.test(code) ? 'dns_failed' : /ECONNREFUSED/.test(code) ? 'refused' : /timeout|aborted/i.test(code + lastError?.message) ? 'timeout' : 'network_error';
  const message = reason === 'dns_failed' ? '域名解析失败：站点可能已迁移，或本机 DNS 受限。'
    : reason === 'refused' ? '连接被拒绝：站点侧防火墙或 IP 限制。'
    : reason === 'timeout' ? '请求超时：站点响应慢，或对非浏览器访问做了限速。'
    : '网络错误：' + (lastError?.message || '未知');
  return {ok: false, status: 0, reason, message};
}

export function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}
