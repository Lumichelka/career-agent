// /mcp 的 Node http ↔ Web Request/Response 适配。
// 路由胶水只放这里，app.mjs 仍然只保留一行；领域逻辑在 src/mcp/inbound.mjs。
export function createInboundHttp({inbound, send, maxBody = 4194304}) {
  return async function handleInbound(req, res, url, origin) {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return send(res, {error: 'Method not allowed'}, 405);
    // 实例开关关闭时端点就是不存在：即使带着有效凭据也回 404。
    if (!inbound.enabled) return send(res, {error: 'Not found'}, 404);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > maxBody) return send(res, {error: '请求过长'}, 413);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const webRequest = new Request(origin + url.pathname + url.search, {
      method: req.method,
      headers,
      ...(raw ? {body: raw} : {})
    });
    const response = await inbound.handle(webRequest);
    if (!response) return send(res, {error: 'Not found'}, 404);
    const outHeaders = Object.fromEntries(response.headers);
    delete outHeaders['cache-control'];
    res.writeHead(response.status, {...outHeaders, 'Cache-Control': 'no-store'});
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return res.end();
  };
}
