// 让 fetch 走 HTTP 代理（CONNECT 隧道），不依赖第三方包，也不需要 Node 24 的实验特性。
// 只在用户显式填写代理时才启用；默认仍用全局 fetch。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import {Readable} from 'node:stream';

function headersToObject(h) {
  if (!h) return {};
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    const out = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return {...h};
}

function compactHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(headersToObject(raw))) {
    if (v === undefined || v === null) continue;
    const key = String(k).toLowerCase();
    if (key === 'accept-encoding' || key === 'connection' || key === 'host') continue;
    out[key] = String(v);
  }
  return out;
}

function tunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: {host: targetHost + ':' + targetPort},
      timeout: 20000
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('代理返回 HTTP ' + res.statusCode)); return; }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.on('error', reject);
    req.end();
  });
}

// 把 Node 的 IncomingMessage 变成 WHATWG Response，保留流式（SSE 可用）
function toResponse(res, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else headers.set(k, String(v));
  }
  const noBody = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
  return new Response(noBody ? null : Readable.toWeb(res), {status: res.statusCode, statusText: res.statusMessage, headers});
}

export function createProxyFetch(proxyUrl, {rejectUnauthorized = true} = {}) {
  let proxy;
  try { proxy = new URL(proxyUrl); } catch { throw new Error('代理地址无效'); }
  return async function proxyFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = compactHeaders(init.headers);
    const targetHost = url.hostname.replace(/^\[|\]$/g, '');
    const isHttps = url.protocol === 'https:';
    const targetPort = Number(url.port || (isHttps ? 443 : 80));
    const body = init.body == null ? null : Buffer.from(typeof init.body === 'string' ? init.body : init.body);
    if (body) headers['content-length'] = String(body.length);

    let socket = null;
    if (isHttps) {
      const raw = await tunnel(proxy, targetHost, targetPort);
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({socket: raw, servername: net.isIP(targetHost) ? undefined : targetHost, rejectUnauthorized}, () => resolve(t));
        t.on('error', reject);
      });
      if (init.signal?.aborted) { socket.destroy(); throw new DOMException('Aborted', 'AbortError'); }
    }

    return await new Promise((resolve, reject) => {
      const options = isHttps
        ? {host: targetHost, port: targetPort, path: url.pathname + url.search, method, headers: {...headers, host: url.host}, agent: false, createConnection: () => socket}
        : {host: proxy.hostname, port: Number(proxy.port || 80), path: url.href, method, headers, agent: false};
      const req = (isHttps ? https : http).request(options, res => resolve(toResponse(res, method)));
      const abort = () => { req.destroy(new DOMException('Aborted', 'AbortError')); };
      init.signal?.addEventListener('abort', abort, {once: true});
      req.on('response', () => init.signal?.removeEventListener('abort', abort));
      req.on('error', err => { init.signal?.removeEventListener('abort', abort); reject(err); });
      if (body) req.write(body);
      req.end();
    });
  };
}

export function makeFetch(proxyUrl) {
  if (!proxyUrl) return fetch;
  return createProxyFetch(proxyUrl);
}
