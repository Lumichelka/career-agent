// 分阶段"接口体检"：DNS → TCP → TLS → 鉴权/路由 → 返回格式 → 工具调用 → JSON 结构。
// 每一层单独给结论和修复建议，用户不用再猜"连接失败"是哪一步。
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import {endpointFor, explainError, isPrivateHostname} from './providers.mjs';

const step = (id, label) => ({id, label, status: 'skip', detail: '', fix: ''});

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + '超时（' + Math.round(ms / 1000) + '秒）')), ms); })
  ]);
}

function baseHeaders(config, extra = {}) {
  const h = {'Content-Type': 'application/json', ...extra};
  if (config.apiKey) {
    if (config.protocol === 'messages') h['x-api-key'] = config.apiKey; else h.Authorization = 'Bearer ' + config.apiKey;
  }
  if (config.protocol === 'messages') h['anthropic-version'] = '2023-06-01';
  return h;
}

function bodyFor(config, {messages, input, tools, json, maxTokens}) {
  if (config.protocol === 'messages') {
    const b = {model: config.model, messages, max_tokens: maxTokens || 64, stream: false};
    if (tools) b.tools = tools.map(t => ({name: t.name, description: t.description, input_schema: t.parameters}));
    return b;
  }
  if (config.protocol === 'responses') {
    const b = {model: config.model, input: input || messages.map(m => ({role: m.role, content: m.content})), stream: false, max_output_tokens: maxTokens || 64};
    if (tools) b.tools = tools.map(t => ({type: 'function', name: t.name, description: t.description, parameters: t.parameters}));
    return b;
  }
  const b = {model: config.model, messages, stream: false, max_tokens: maxTokens || 64};
  if (tools) b.tools = tools.map(t => ({type: 'function', function: t}));
  if (json) b.response_format = {type: 'json_object'};
  return b;
}

function readReply(config, data) {
  if (config.protocol === 'messages') {
    if (!Array.isArray(data.content)) throw new Error('返回内容不是 Messages 格式');
    return {
      text: data.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      tools: data.content.filter(c => c.type === 'tool_use').map(c => c.name)
    };
  }
  if (config.protocol === 'responses') {
    if (!Array.isArray(data.output)) throw new Error('返回内容不是 Responses 格式');
    return {
      text: data.output.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(''),
      tools: data.output.filter(o => o.type === 'function_call').map(o => o.name)
    };
  }
  const m = data.choices?.[0]?.message;
  if (!m) throw new Error('返回内容不是 Chat Completions 格式');
  return {text: typeof m.content === 'string' ? m.content : '', tools: (m.tool_calls || []).map(t => t.function?.name), reasoning: m.reasoning_content};
}

export async function runDiagnostics(config, {fetchImpl = fetch, timeout = 20000} = {}) {
  const stages = [];
  const env = step('env', '运行环境');
  env.status = 'pass';
  env.detail = 'Node ' + process.version + ' · ' + process.platform + ' · 代理：' + (config.proxy || '未配置');
  stages.push(env);

  const cfg = {...config};
  let endpoint;
  try {
    endpoint = new URL(endpointFor(cfg.baseUrl, cfg.protocol));
    const s = step('endpoint', '接口地址');
    s.status = 'pass';
    s.detail = endpoint.href;
    if (isPrivateHostname(endpoint.hostname)) s.detail += '（本机/局域网地址）';
    stages.push(s);
  } catch (e) {
    const s = step('endpoint', '接口地址');
    s.status = 'fail';
    s.detail = e.message;
    s.fix = '按“供应商预设”重新选择，或填写到 /v1 为止的基础地址。';
    stages.push(s);
    return {ok: false, stages, hint: '地址格式就错了，先改地址。'};
  }

  const dnsStage = step('dns', '域名解析');
  try {
    if (net.isIP(endpoint.hostname)) { dnsStage.status = 'pass'; dnsStage.detail = 'IP 直连，跳过解析'; }
    else {
      const t = Date.now();
      const r = await withTimeout(dns.lookup(endpoint.hostname, {all: true}), 8000, '域名解析');
      dnsStage.status = 'pass';
      dnsStage.detail = r.map(x => x.address).join(', ') + ' · ' + (Date.now() - t) + 'ms';
    }
  } catch (e) {
    dnsStage.status = 'fail';
    dnsStage.detail = e.message;
    dnsStage.fix = '检查域名拼写；国内访问境外接口需要代理，或改用国内供应商（DeepSeek/智谱/通义/Kimi）。';
    stages.push(dnsStage);
    return {ok: false, stages, hint: '域名都解析不了，后面不用测了。'};
  }
  stages.push(dnsStage);

  const port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
  const tcpStage = step('tcp', '端口连通');
  try {
    const t = Date.now();
    await withTimeout(new Promise((resolve, reject) => {
      const s = net.connect({host: endpoint.hostname.replace(/^\[|\]$/g, ''), port}, () => { s.destroy(); resolve(); });
      s.on('error', reject);
      s.setTimeout(8000, () => { s.destroy(); reject(new Error('TCP 连接超时')); });
    }), 9000, '端口连通');
    tcpStage.status = 'pass';
    tcpStage.detail = endpoint.hostname + ':' + port + ' · ' + (Date.now() - t) + 'ms';
  } catch (e) {
    tcpStage.status = 'fail';
    tcpStage.detail = e.message;
    tcpStage.fix = '端口不通：服务没启动、端口写错、被防火墙拦截，或需要代理。';
    stages.push(tcpStage);
    return {ok: false, stages, hint: '网络层不通，先解决网络或改用代理。'};
  }
  stages.push(tcpStage);

  if (endpoint.protocol === 'https:') {
    const tStage = step('tls', 'HTTPS 证书');
    try {
      const cert = await withTimeout(new Promise((resolve, reject) => {
        const s = tls.connect({host: endpoint.hostname.replace(/^\[|\]$/g, ''), port, servername: net.isIP(endpoint.hostname) ? undefined : endpoint.hostname}, () => {
          resolve({protocol: s.getProtocol(), cert: s.getPeerCertificate()}); s.end();
        });
        s.on('error', reject);
      }), 9000, 'TLS 握手');
      tStage.status = 'pass';
      tStage.detail = cert.protocol + (cert.cert?.issuer?.O ? ' · 颁发者 ' + cert.cert.issuer.O : '');
    } catch (e) {
      tStage.status = 'fail';
      tStage.detail = e.message;
      tStage.fix = '自建服务请换受信任证书；本机服务请用 http://127.0.0.1。';
      stages.push(tStage);
      return {ok: false, stages, hint: '证书过不去，浏览器/程序都会拒绝。'};
    }
    stages.push(tStage);
  }

  const authStage = step('http', '接口与鉴权');
  let reply = null;
  const started = Date.now();
  try {
    const res = await withTimeout(fetchImpl(endpoint.href, {
      method: 'POST',
      headers: baseHeaders(cfg),
      body: JSON.stringify(bodyFor(cfg, {messages: [{role: 'user', content: '连通性测试，请只回复 OK'}], maxTokens: 32})),
      signal: AbortSignal.timeout(timeout)
    }), timeout + 2000, '接口请求');
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? '鉴权失败：Key 不对、过期或无权限。'
        : res.status === 404 ? '路径或模型不存在：多半是协议选错（chat/responses/messages）或模型名写错。'
        : res.status === 429 ? '额度/频率受限：稍后再试或换备用接口。'
        : res.status >= 500 ? '服务端错误：换时间重试或换供应商。' : '接口返回失败。';
      authStage.status = 'fail';
      authStage.detail = 'HTTP ' + res.status + ' · ' + text.slice(0, 300);
      authStage.fix = hint;
      stages.push(authStage);
      return {ok: false, stages, hint};
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回的不是 JSON：' + text.slice(0, 200)); }
    reply = readReply(cfg, data);
    authStage.status = 'pass';
    authStage.detail = 'HTTP 200 · ' + (Date.now() - started) + 'ms · 回复「' + String(reply.text || reply.reasoning || '').trim().slice(0, 40) + '」';
  } catch (e) {
    authStage.status = 'fail';
    authStage.detail = e.message;
    authStage.fix = explainError(e).text;
    stages.push(authStage);
    return {ok: false, stages, hint: explainError(e).text};
  }
  stages.push(authStage);

  const toolStage = step('tools', '工具调用能力');
  try {
    const tools = [{name: 'ping', description: '连通性测试工具，调用一次即可', parameters: {type: 'object', properties: {}, additionalProperties: false}}];
    const res = await withTimeout(fetchImpl(endpoint.href, {
      method: 'POST',
      headers: baseHeaders(cfg),
      body: JSON.stringify(bodyFor(cfg, {messages: [{role: 'user', content: '请调用 ping 工具一次，不要用文字回答。'}], tools, maxTokens: 128})),
      signal: AbortSignal.timeout(timeout)
    }), timeout + 2000, '工具调用测试');
    const data = await res.json();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = readReply(cfg, data);
    if (r.tools?.includes('ping')) { toolStage.status = 'pass'; toolStage.detail = '模型能发起工具调用'; }
    else { toolStage.status = 'warn'; toolStage.detail = '模型没有发起工具调用'; toolStage.fix = '该模型可能不支持 function calling，检索类功能会退化；建议换 DeepSeek/GLM/Qwen 等支持工具的模型。'; }
  } catch (e) {
    toolStage.status = 'warn';
    toolStage.detail = e.message;
    toolStage.fix = '工具调用测试失败不影响纯文本对话，但联网检索与平台读取会不可用。';
  }
  stages.push(toolStage);

  const jsonStage = step('json', '结构化输出');
  try {
    const res = await withTimeout(fetchImpl(endpoint.href, {
      method: 'POST',
      headers: baseHeaders(cfg),
      body: JSON.stringify(bodyFor(cfg, {messages: [{role: 'user', content: '只输出一个 JSON 对象：{"ok":true}，不要解释、不要代码围栏。'}], json: cfg.protocol === 'chat', maxTokens: 64})),
      signal: AbortSignal.timeout(timeout)
    }), timeout + 2000, 'JSON 测试');
    const data = await res.json();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = readReply(cfg, data);
    const cleaned = String(r.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    JSON.parse(cleaned);
    jsonStage.status = 'pass';
    jsonStage.detail = '能用 JSON 回复';
  } catch (e) {
    jsonStage.status = 'warn';
    jsonStage.detail = e.message;
    jsonStage.fix = '若模型经常不返回 JSON，长任务容易中断；换更强模型，或把一次任务拆小。';
  }
  stages.push(jsonStage);

  const ok = stages.every(s => s.status !== 'fail');
  const warnings = stages.filter(s => s.status === 'warn');
  return {
    ok,
    stages,
    hint: ok ? (warnings.length ? '基本可用，但有 ' + warnings.length + ' 项提醒。' : '全部通过，可以开始对话。') : '存在失败项，按修复建议处理。'
  };
}
