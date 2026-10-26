// 外部 Agent 工具进入统一工具面（#35）。
// 负责：命名 mcp__<agentSlug>__<tool>、任务开始 pin 快照、统一结果信封
// （给模型 ≤64KB / 完整响应 ≤1MB 证据文件）、固定错误码与恢复建议、
// 进度节流、取消链（2 秒宽限后丢连接）、首次出网确认、上游写分级与幂等透传。
// 连接、发现缓存与进程回收归 #34（src/mcp/client.mjs）；这里只经 connections.pin/callTool/disconnect 接出去。
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const EXTERNAL_PREFIX = 'mcp__';
export const MAX_TOOL_NAME = 128;
export const MAX_SLUG = 24;
export const MAX_MODEL_TEXT = 64 * 1024;
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CALL_TIMEOUT_MS = 60000;
export const MAX_CALL_TIMEOUT_MS = 300000;
export const CANCEL_GRACE_MS = 2000;
export const PROGRESS_MIN_MS = 200;

export const OUTBOUND_WARNING = '它会看到你交给它的内容；上游副作用不可撤销。';

// 固定错误码（契约 §8.3）：每条都必须有恢复建议，界面与服务端共用一份。
export const EXTERNAL_ERROR_CODES = [
  'CONNECT_FAILED', 'AUTH_FAILED', 'ERA_NEGOTIATION_FAILED', 'REQUEST_TIMEOUT', 'CANCELLED',
  'UPSTREAM_ERROR', 'TOOL_ERROR', 'UNSUPPORTED', 'QUEUE_TIMEOUT', 'RESULT_TOO_LARGE', 'INVALID_RESULT'
];

export const EXTERNAL_RECOVERY = {
  CONNECT_FAILED: '检查命令或 URL、网络与上游是否在运行，然后重试连接。',
  AUTH_FAILED: '更新 Bearer token 或自定义 header；本应用不实现 OAuth，401/403 不会自动刷新。',
  ERA_NEGOTIATION_FAILED: '确认上游是 MCP server 并支持 Streamable HTTP；换传输或换入口后再试。',
  REQUEST_TIMEOUT: '上游响应超时：缩小输入、稍后重试，或换一个 Agent。',
  CANCELLED: '无需恢复；需要时重新发起这次调用。',
  UPSTREAM_ERROR: '连接已建立但调用失败：查看上游日志后重试，或换一个工具。',
  TOOL_ERROR: '上游按正常协议返回了 isError：按它的 message 修正参数后再试。',
  UNSUPPORTED: '上游或本应用没有实现该能力；在外部 Agent 侧完成这一步。',
  QUEUE_TIMEOUT: '上游并发已满且排队超时：稍后重试或减少并发。',
  RESULT_TOO_LARGE: '上游返回超过上限：让上游缩小返回内容后再试。',
  INVALID_RESULT: '结果结构不符合 MCP 约定：报告上游，重试不会自行修好。'
};

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

// URL 里的用户信息或查询串按凭据处理：错误消息、证据与状态里都只留脱敏地址。
export function sanitizeExternalMessage(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s"'<>]+/g, raw => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return raw; }
  });
}

// ---------------------------------------------------------------- 命名

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
}

// 用户可读 slug：撞名加 -2 / -3；全中文或空名用 agent-<序号> 兜底。
export function assignSlugs(agents = []) {
  const used = new Set();
  return agents.map((agent, index) => {
    const base = slugify(agent?.name) || ('agent-' + (index + 1));
    let slug = base.slice(0, MAX_SLUG);
    let n = 1;
    while (used.has(slug)) {
      n += 1;
      const suffix = '-' + n;
      slug = base.slice(0, MAX_SLUG - suffix.length) + suffix;
    }
    used.add(slug);
    return {id: agent?.id || '', name: agent?.name || '', slug};
  });
}

// 总长 ≤128：超长时截断工具名并追加 8 位哈希，保留可读前缀。
export function externalToolName(slug, toolName) {
  const raw = String(toolName ?? '');
  const prefix = EXTERNAL_PREFIX + String(slug ?? '') + '__';
  const full = prefix + raw;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const room = Math.max(1, MAX_TOOL_NAME - prefix.length - 9);
  return prefix + raw.slice(0, room) + '-' + hash;
}

// 本地工具永远在前，上游工具按接口给的顺序（pin 时已按 Agent 名排好）。
export function mergeToolSurface(localTools = [], externalTools = []) {
  return [...localTools, ...externalTools];
}

// Codex 是子进程执行体，工具面来自内部 stdio 桥的静态注册；动态注入不可行时明确说明，不假装支持。
export function externalToolsSupported(kind) {
  if (kind === 'codex') {
    return {
      supported: false,
      message: 'Codex 后端不支持把外部 Agent 工具动态加入本轮工具面：本轮只用本地工具；需要外部 Agent 工具时请切换到模型 API 后端。'
    };
  }
  return {supported: true, message: ''};
}

// ---------------------------------------------------------------- 进度

// 进度：只发严格递增的值；两次事件之间至少间隔 minMs（默认 200ms），节流窗口内的值直接丢弃。
export function createProgressReporter({emit = () => {}, taskId = '', agentId = '', agentName = '', tool = '', now = Date.now, minMs = PROGRESS_MIN_MS} = {}) {
  let last = -Infinity;
  let lastAt = -Infinity;
  let emitted = 0;
  return {
    report(update) {
      const value = Number(update && typeof update === 'object' ? update.progress : update);
      if (!Number.isFinite(value) || value <= last) return false;
      const at = now();
      if (emitted > 0 && at - lastAt < minMs) return false;
      last = value;
      lastAt = at;
      emitted += 1;
      const event = {type: 'tool_progress', taskId, agentId, agentName, tool, progress: value, at: new Date(at).toISOString()};
      const total = Number(update?.total);
      if (Number.isFinite(total)) event.total = total;
      if (update?.message) event.message = String(update.message).slice(0, 200);
      emit(event);
      return true;
    }
  };
}

// ---------------------------------------------------------------- 错误与信封

function cancelledError(message = '本次外部调用已取消，结果已丢弃。') {
  return Object.assign(new Error(message), {code: 'CANCELLED', recovery: EXTERNAL_RECOVERY.CANCELLED});
}

// 把连接层/上游的失败面映射到固定错误码；未知一律 UPSTREAM_ERROR。
export function externalError(error) {
  const message = sanitizeExternalMessage(error?.message || String(error ?? '外部 Agent 调用失败'));
  const raw = String(error?.code || '');
  const status = Number(error?.status || error?.data?.status || 0);
  const text = raw + ' ' + message;
  let code;
  if (raw === 'CANCELLED' || /AbortError|aborted|cancelled|已停止/i.test(text)) code = 'CANCELLED';
  else if (EXTERNAL_ERROR_CODES.includes(raw)) code = raw;
  else if (status === 401 || status === 403 || /AUTH|UNAUTHOR|FORBIDDEN|\b401\b|\b403\b|invalid.?token|api.?key/i.test(text)) code = 'AUTH_FAILED';
  else if (/ERA_NEGOTIATION|UNSUPPORTED_PROTOCOL|PROTOCOL_VERSION/i.test(text)) code = 'ERA_NEGOTIATION_FAILED';
  else if (/RESULT_TOO_LARGE|message too (big|large)|payload too large/i.test(text)) code = 'RESULT_TOO_LARGE';
  else if (/TIMEOUT|ETIMEDOUT|timed out|timeout/i.test(text)) code = 'REQUEST_TIMEOUT';
  else if (/CONNECT|ENOENT|ECONNREFUSED|ENOTFOUND|DNS|TLS|spawn/i.test(text)) code = 'CONNECT_FAILED';
  else code = 'UPSTREAM_ERROR';
  return {code, message: message.slice(0, 2000), recovery: EXTERNAL_RECOVERY[code] || EXTERNAL_RECOVERY.UPSTREAM_ERROR};
}

export function externalEvidence({agentId = '', tool = '', requestId = '', at = new Date().toISOString(), era = '', durationMs = 0, actorType = 'external_agent', actorRef = '', actorName = ''} = {}) {
  const out = {actorType, agentId, tool, requestId, at, era, durationMs};
  // 默认（本应用任务里调用外部 Agent）保持原有信封形状；入站转发（#38）才追加来源字段。
  if (actorType !== 'external_agent') {
    if (actorRef) out.actorRef = actorRef;
    if (actorName) out.actorName = actorName;
  }
  return out;
}

// 统一信封：status / data / error / evidence / truncated / assets；上游写另带 readOnly 与 retryable。
export function buildEnvelope({status = 'ok', data = null, error = null, evidence = {}, truncated = false, assets = [], readOnly = false, retryable = true, idempotency = ''} = {}) {
  const out = {
    status,
    evidence: {...evidence, actorType: evidence?.actorType || 'external_agent'},
    readOnly: readOnly === true,
    retryable: retryable !== false
  };
  // 上游写幂等口径：#36 把 readOnly / retryable / idempotency 三个字段一起放进信封。
  if (idempotency) out.idempotency = String(idempotency);
  if (status === 'ok') out.data = data || {text: ''};
  else {
    const code = EXTERNAL_ERROR_CODES.includes(error?.code) ? error.code : 'UPSTREAM_ERROR';
    out.error = {
      code,
      message: String(error?.message || '').slice(0, 2000),
      recovery: error?.recovery || EXTERNAL_RECOVERY[code] || EXTERNAL_RECOVERY.UPSTREAM_ERROR
    };
  }
  if (truncated) out.truncated = true;
  if (Array.isArray(assets) && assets.length) out.assets = assets.map(asset => ({...asset}));
  return out;
}

// 给模型的文本硬上限 64KB：超了就压缩 data.text 并标 truncated，其余字段保持可读。
export function envelopeForModel(envelope, maxBytes = MAX_MODEL_TEXT) {
  const full = JSON.stringify(envelope);
  if (byteLength(full) <= maxBytes) return full;
  const base = {
    status: envelope?.status === 'ok' ? 'ok' : 'error',
    evidence: {...(envelope?.evidence || {}), actorType: envelope?.evidence?.actorType || 'external_agent'},
    readOnly: envelope?.readOnly === true,
    retryable: envelope?.retryable !== false,
    truncated: true
  };
  if (envelope?.assets?.length) base.assets = envelope.assets.map(asset => ({...asset}));
  if (base.status === 'ok') {
    base.data = {text: ''};
    const text = String(envelope?.data?.text ?? '');
    let keep = text.length;
    while (keep > 0) {
      base.data.text = text.slice(0, keep) + '\n…（内容超过 64KB，已截断）';
      if (byteLength(JSON.stringify(base)) <= maxBytes) return JSON.stringify(base);
      keep = Math.floor(keep * 0.7);
    }
    base.data.text = '';
    return JSON.stringify(base);
  }
  base.error = {...envelope.error};
  const text = String(base.error.message || '');
  let keep = text.length;
  while (keep > 0 && byteLength(JSON.stringify({...base, error: {...base.error, message: text.slice(0, keep)}})) > maxBytes) keep = Math.floor(keep * 0.7);
  base.error.message = text.slice(0, keep);
  if (byteLength(JSON.stringify(base)) <= maxBytes) return JSON.stringify(base);
  // 极端情况：元数据本身就超限（例如资产特别多），丢掉可变部分但保留信封骨架。
  return JSON.stringify({
    status: base.status,
    evidence: {...base.evidence},
    readOnly: base.readOnly,
    retryable: base.retryable,
    truncated: true,
    ...(base.status === 'ok' ? {data: {text: ''}} : {error: {code: base.error.code, message: '', recovery: base.error.recovery}})
  });
}

function mimeExt(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('json')) return 'json';
  if (type.includes('pdf')) return 'pdf';
  if (type.includes('svg')) return 'svg';
  if (type.includes('text')) return 'txt';
  return 'bin';
}

// image / resource / audio 块落成任务证据资产；模型只看到占位。
async function saveAsset(block, {requestId, assetsDir, assets}) {
  const id = randomUUID().slice(0, 8);
  const asset = {id, type: String(block.type || 'resource'), uri: '', mimeType: String(block.mimeType || ''), bytes: 0};
  const write = async (ext, data) => {
    try {
      await mkdir(assetsDir, {recursive: true});
      const file = join(assetsDir, 'asset-' + requestId + '-' + id + '.' + ext);
      await writeFile(file, data);
      asset.uri = file;
      asset.bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), 'utf8');
    } catch { /* 证据落盘失败不影响调用本身 */ }
  };
  if (block.type === 'image' && typeof block.data === 'string') {
    await write(mimeExt(block.mimeType), Buffer.from(block.data, 'base64'));
  } else if (block.type === 'audio' && typeof block.data === 'string') {
    await write(mimeExt(block.mimeType || 'audio'), Buffer.from(block.data, 'base64'));
  } else if (block.type === 'resource') {
    const resource = block.resource && typeof block.resource === 'object' ? block.resource : {};
    if (typeof resource.text === 'string') await write(mimeExt(resource.mimeType || 'text/plain'), resource.text);
    else if (typeof resource.blob === 'string') await write(mimeExt(resource.mimeType), Buffer.from(resource.blob, 'base64'));
    else if (typeof resource.uri === 'string') {
      asset.uri = resource.uri;
      asset.mimeType = String(resource.mimeType || '');
    }
  }
  assets.push(asset);
  return asset;
}

// 内容归一化：text 按序拼接；image/resource 存资产并给占位；未知块保留 JSON 摘要。
async function normalizeResult(result, {requestId, assetsDir, assets}) {
  const content = result && Array.isArray(result.content) ? result.content : null;
  if (!content) return {invalid: true, reason: '结果没有 content 数组'};
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') return {invalid: true, reason: 'content 里有非对象块'};
    if (block.type === 'text') { parts.push(String(block.text ?? '')); continue; }
    if (block.type === 'image' || block.type === 'resource' || block.type === 'audio') {
      const asset = await saveAsset(block, {requestId, assetsDir, assets});
      const label = block.type === 'image' ? '图片' : block.type === 'audio' ? '音频' : '资源';
      parts.push('〔' + label + '已存为证据 ' + asset.id + '〕');
      continue;
    }
    parts.push(JSON.stringify(block).slice(0, 2000));
  }
  return {
    text: parts.join('\n'),
    structured: result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null,
    isError: result.isError === true,
    invalid: false
  };
}

function truncateEvidence(payload, cap) {
  const textOf = value => {
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value.content)) {
      return value.content.map(block => (typeof block?.text === 'string' ? block.text : JSON.stringify(block))).join('\n');
    }
    return JSON.stringify(value);
  };
  const base = {
    requestId: payload.requestId || '', agentId: payload.agentId || '', agentName: payload.agentName || '',
    tool: payload.tool || '', upstreamTool: payload.upstreamTool || '', at: payload.at || '',
    era: payload.era || '', durationMs: payload.durationMs || 0, readOnly: payload.readOnly === true,
    truncated: true
  };
  const preview = textOf(payload.result) || textOf(payload.error) || '';
  let keep = preview.length;
  for (;;) {
    const candidate = {...base, preview: preview.slice(0, keep)};
    if (byteLength(JSON.stringify(candidate)) <= cap) return JSON.stringify(candidate);
    if (keep === 0) break;
    keep = Math.floor(keep * 0.6);
  }
  const minimal = {requestId: base.requestId, truncated: true, note: '证据文件超过上限，未能保留预览'};
  return JSON.stringify(minimal);
}

// ---------------------------------------------------------------- 工具面

export class ExternalToolset {
  constructor({
    userId = '', taskId = '', home = '', evidenceDir = '',
    config, connections, emit = () => {}, askConsent = null, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, graceMs = CANCEL_GRACE_MS,
    maxRawBytes = MAX_RAW_BYTES, maxModelBytes = MAX_MODEL_TEXT, maxEvidenceBytes = MAX_EVIDENCE_BYTES,
    progressMinMs = PROGRESS_MIN_MS,
    // 入站转发（#38）每次 ListTools 都要看到上游最新的工具，不能吃 10 分钟发现缓存；任务内仍用 pin 快照。
    refreshTools = false,
    // 来源标记：本应用任务里是 external_agent；入站转发是 forwarded_client + client id（审计/证据要能认出）。
    actorType = 'external_agent', actorRef = '', actorName = ''
  } = {}) {
    if (!config || !connections) throw new Error('ExternalToolset 需要 config 与 connections');
    this.userId = userId;
    this.taskId = taskId;
    this.home = home;
    this.evidenceDir = evidenceDir;
    this.config = config;
    this.connections = connections;
    this.emit = emit;
    this.askConsent = askConsent;
    this.now = now;
    this.sleep = sleep;
    this.callTimeoutMs = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(1, Number(callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.maxRawBytes = Math.max(1, Number(maxRawBytes) || MAX_RAW_BYTES);
    this.maxModelBytes = Math.max(1, Number(maxModelBytes) || MAX_MODEL_TEXT);
    this.maxEvidenceBytes = Math.max(1, Number(maxEvidenceBytes) || MAX_EVIDENCE_BYTES);
    this.progressMinMs = Math.max(0, Number(progressMinMs) || 0);
    this.refreshTools = refreshTools === true;
    this.actorType = String(actorType || 'external_agent');
    this.actorRef = String(actorRef || '');
    this.actorName = String(actorName || '');
    this.tools = [];
    this.snapshot = null;
    this.agents = new Map();
    this.consented = new Set();
    this.idempotencySeq = 0;
  }

  #descriptor(entry, tool) {
    const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    const properties = schema.properties && typeof schema.properties === 'object' ? {...schema.properties} : {};
    const parameters = {type: 'object', properties};
    if (Array.isArray(schema.required)) parameters.required = schema.required.filter(key => typeof key === 'string');
    if (schema.additionalProperties === false) parameters.additionalProperties = false;
    const readOnly = tool.readOnly === true || tool.annotations?.readOnlyHint === true;
    return {
      name: externalToolName(entry.slug, tool.name),
      title: '外部 Agent 工具',
      description: '外部 Agent「' + entry.name + '」提供的工具 ' + tool.name + '：' + (tool.description || '上游未提供说明') + '。调用会把任务内容发送给该 Agent。',
      parameters,
      permission: 'read',
      external: true,
      timeoutMs: this.callTimeoutMs + this.graceMs + 2000,
      agentId: entry.id,
      agentName: entry.name,
      agentSlug: entry.slug,
      upstreamTool: tool.name,
      readOnly,
      upstream: {inputSchema: schema, annotations: tool.annotations || null}
    };
  }

  // 任务开始 pin 一份：连接、发现并按 Agent 名排序；单个 Agent 不可用不拖垮整个任务。
  async pin() {
    const enabled = (this.config.agents || []).filter(agent => agent && agent.enabled !== false);
    const named = assignSlugs(enabled.map(agent => ({id: agent.id, name: agent.name})));
    const ordered = [...named].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const tools = [];
    const summary = [];
    const unavailable = [];
    for (const entry of ordered) {
      const agent = enabled.find(item => item.id === entry.id);
      let era = '';
      try {
        const upstream = this.refreshTools && typeof this.connections.refresh === 'function'
          ? (await this.connections.refresh(agent.id)).tools
          : await this.connections.pin(agent.id);
        if (typeof this.connections.status === 'function') {
          const status = await this.connections.status(agent.id).catch(() => null);
          era = String(status?.era || '');
        }
        const list = (Array.isArray(upstream) ? upstream : []).map(tool => this.#descriptor(entry, tool));
        tools.push(...list);
        summary.push({id: entry.id, name: entry.name, slug: entry.slug, era, tools: list.length});
        this.agents.set(agent.id, {id: entry.id, name: entry.name, slug: entry.slug, entity: agent, era});
      } catch (error) {
        const mapped = externalError(error);
        // slug 一起带回：入站转发要能按 mcp__<slug>__ 前缀判断是哪个 Agent 连不上（#38）。
        unavailable.push({agentId: agent.id, name: agent.name, slug: entry.slug, ...mapped});
        this.emit({type: 'status', text: '外部 Agent「' + agent.name + '」本轮不可用（' + mapped.code + '），其余工具照常使用。'});
      }
    }
    this.tools = tools;
    this.snapshot = {tools, agents: summary, unavailable, pinnedAt: new Date(this.now()).toISOString()};
    return this.snapshot;
  }

  // 首次出网确认：配置里已选「以后不再问」就跳过；同一任务接受过「仅本次」也不再问。
  async ensureConsent(agent) {
    const stored = typeof this.config.outboundConsent === 'function' ? this.config.outboundConsent(agent.id) : {};
    if (stored?.neverAsk === true) return {ok: true, decision: 'always'};
    if (this.consented.has(agent.id)) return {ok: true, decision: 'once'};
    if (typeof this.askConsent !== 'function') {
      return {ok: false, decision: 'reject', message: '首次出网确认没有接通，本次没有发送内容。'};
    }
    let answer;
    try { answer = await this.askConsent({agentId: agent.id, agentName: agent.name, warning: OUTBOUND_WARNING}); }
    catch { answer = {decision: 'reject'}; }
    const decision = typeof answer === 'string' ? answer : answer?.decision;
    if (decision === 'always') {
      if (typeof this.config.approveOutbound === 'function') await this.config.approveOutbound(agent.id, {neverAsk: true}).catch(() => {});
      this.consented.add(agent.id);
      return {ok: true, decision: 'always'};
    }
    if (decision === 'once') {
      this.consented.add(agent.id);
      return {ok: true, decision: 'once'};
    }
    return {ok: false, decision: 'reject', message: answer?.message || ''};
  }

  #prepareArgs(descriptor, args) {
    const out = {...(args && typeof args === 'object' && !Array.isArray(args) ? args : {})};
    if (descriptor.readOnly) return {args: out, retryable: true, idempotency: 'read_only'};
    const properties = descriptor.parameters?.properties && typeof descriptor.parameters.properties === 'object' ? descriptor.parameters.properties : {};
    const field = Object.hasOwn(properties, 'idempotencyKey') ? 'idempotencyKey'
      : Object.hasOwn(properties, 'idempotency_key') ? 'idempotency_key' : '';
    if (!field) return {args: out, retryable: false, idempotency: 'upstream_unsupported'};
    if (typeof out[field] !== 'string' || !out[field].trim()) {
      this.idempotencySeq += 1;
      out[field] = 'task-' + this.taskId + '-' + this.idempotencySeq;
    }
    return {args: out, retryable: true, idempotency: field};
  }

  // 取消链：拿到 AbortSignal 后丢弃结果；宽限期结束还没停就丢连接（连接层负责杀进程树）。
  async #invoke({descriptor, agent, args, signal, onprogress}) {
    // 已取消就绝不把内容发出去（哪怕取消发生在等待确认期间）。
    if (signal?.aborted) throw cancelledError();
    const options = {timeout: this.callTimeoutMs, onprogress};
    if (signal) options.signal = signal;
    // 让连接层把当前任务事件流挂到这次调用上：MRTR 的 elicitation 要弹到正确的对话页。
    options.context = {taskId: this.taskId, emit: this.emit, signal};
    const call = Promise.resolve().then(() => this.connections.callTool(agent.entity.id, descriptor.upstreamTool, args, options));
    if (!signal) return call;
    const settled = call.then(value => ({value}), error => ({error}));
    let onAbort = null;
    const aborted = new Promise(resolve => {
      onAbort = () => resolve({aborted: true});
      signal.addEventListener('abort', onAbort, {once: true});
    });
    try {
      const winner = await Promise.race([settled, aborted]);
      if (!winner.aborted) {
        if ('error' in winner) throw winner.error;
        return winner.value;
      }
      settled.catch(() => {});
      const finished = await Promise.race([settled.then(() => true, () => true), this.sleep(this.graceMs).then(() => false)]);
      if (!finished) {
        try { await this.connections.disconnect(agent.entity.id, 'cancelled'); } catch { /* 回收失败也要报取消 */ }
      }
      throw cancelledError();
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  #emitEvidence(envelope, {agent, descriptor, idempotency = ''}) {
    const kind = descriptor.readOnly ? '只读' : '写，远端副作用不可撤销';
    const label = '外部调用：' + agent.name + ' · ' + descriptor.upstreamTool + '（' + kind + '）';
    const detail = JSON.stringify({
      requestId: envelope.evidence.requestId,
      status: envelope.status,
      code: envelope.error?.code || '',
      era: envelope.evidence.era,
      durationMs: envelope.evidence.durationMs,
      retryable: envelope.retryable,
      idempotency
    });
    this.emit({type: 'evidence', evidence: {kind: 'external_call', label: label.slice(0, 200), detail: detail.slice(0, 2000)}});
  }

  async #writeEvidence({requestId, descriptor, agent, args, result, error = null, durationMs, era}) {
    if (!this.evidenceDir) return '';
    const payload = {
      requestId,
      ...(this.actorType !== 'external_agent' ? {actorType: this.actorType, actorRef: this.actorRef, ...(this.actorName ? {actorName: this.actorName} : {})} : {}),
      agentId: descriptor.agentId,
      agentName: agent.name,
      tool: descriptor.name,
      upstreamTool: descriptor.upstreamTool,
      at: new Date(this.now()).toISOString(),
      era,
      durationMs,
      readOnly: descriptor.readOnly,
      args,
      result: result ?? null,
      ...(error ? {error} : {})
    };
    let text = JSON.stringify(payload);
    if (byteLength(text) > this.maxEvidenceBytes) text = truncateEvidence(payload, this.maxEvidenceBytes);
    try {
      await mkdir(this.evidenceDir, {recursive: true});
      const file = join(this.evidenceDir, 'mcp-' + requestId + '.json');
      await writeFile(file, text, 'utf8');
      return file;
    } catch { return ''; }
  }

  #fail(error, evidence, {readOnly = false, retryable = true} = {}) {
    return buildEnvelope({status: 'error', error, evidence, readOnly, retryable});
  }

  async callTool(descriptorOrName, args = {}, ctx = {}) {
    const descriptor = typeof descriptorOrName === 'string'
      ? this.tools.find(tool => tool.name === descriptorOrName) || null
      : descriptorOrName;
    const started = this.now();
    const at = new Date(started).toISOString();
    const requestId = randomUUID();
    const tool = descriptor?.name || String(descriptorOrName || '');
    const agent = descriptor ? this.agents.get(descriptor.agentId) || null : null;
    const base = externalEvidence({agentId: descriptor?.agentId || '', tool, requestId, at, era: agent?.era || '', durationMs: 0, actorType: this.actorType, actorRef: this.actorRef, actorName: this.actorName});

    if (!descriptor || !agent) {
      const out = this.#fail({code: 'UNSUPPORTED', message: '本轮工具面没有这个外部工具：' + tool}, base);
      this.emit({type: 'evidence', evidence: {kind: 'external_call', label: '外部调用未发出：' + tool, detail: 'UNSUPPORTED'}});
      return out;
    }
    if (ctx.signal?.aborted) {
      const out = this.#fail(cancelledError(), {...base, durationMs: 0}, {readOnly: descriptor.readOnly, retryable: false});
      return out;
    }
    const consent = await this.ensureConsent(agent.entity);
    if (!consent.ok) {
      const out = this.#fail({
        code: 'CANCELLED',
        message: '用户拒绝把内容发送给外部 Agent「' + agent.name + '」，本次调用未发出。' + (consent.message ? ' ' + consent.message : ''),
        recovery: EXTERNAL_RECOVERY.CANCELLED
      }, {...base, durationMs: this.now() - started}, {readOnly: descriptor.readOnly, retryable: false});
      this.#emitEvidence(out, {agent, descriptor});
      return out;
    }

    const prepared = this.#prepareArgs(descriptor, args);
    const progress = createProgressReporter({
      emit: this.emit, taskId: this.taskId, agentId: descriptor.agentId, agentName: agent.name,
      tool: descriptor.name, now: this.now, minMs: this.progressMinMs
    });
    let result;
    try {
      result = await this.#invoke({descriptor, agent, args: prepared.args, signal: ctx.signal, onprogress: update => progress.report(update)});
    } catch (error) {
      const mapped = externalError(error);
      const evidence = {...base, durationMs: this.now() - started};
      const out = this.#fail(mapped, evidence, {readOnly: descriptor.readOnly, retryable: prepared.retryable});
      if (mapped.code !== 'CANCELLED') {
        await this.#writeEvidence({requestId, descriptor, agent, args: prepared.args, result: null, error: out.error, durationMs: evidence.durationMs, era: agent.era});
      }
      this.#emitEvidence(out, {agent, descriptor, idempotency: prepared.idempotency});
      return out;
    }

    const durationMs = this.now() - started;
    const evidence = {...base, durationMs};
    const rawText = (() => { try { return JSON.stringify(result); } catch { return ''; } })();
    if (byteLength(rawText) > this.maxRawBytes) {
      const out = this.#fail({code: 'RESULT_TOO_LARGE', message: '上游返回超过上限（' + byteLength(rawText) + ' 字节）。'}, evidence, {readOnly: descriptor.readOnly, retryable: false});
      await this.#writeEvidence({requestId, descriptor, agent, args: prepared.args, result: null, error: out.error, durationMs, era: agent.era});
      this.#emitEvidence(out, {agent, descriptor, idempotency: prepared.idempotency});
      return out;
    }

    const assets = [];
    const normalized = await normalizeResult(result, {requestId, assetsDir: this.evidenceDir, assets});
    if (normalized.invalid) {
      const out = this.#fail({code: 'INVALID_RESULT', message: '结果结构不符合 MCP 约定：' + normalized.reason}, evidence, {readOnly: descriptor.readOnly, retryable: false});
      await this.#writeEvidence({requestId, descriptor, agent, args: prepared.args, result, durationMs, era: agent.era});
      this.#emitEvidence(out, {agent, descriptor, idempotency: prepared.idempotency});
      return out;
    }
    await this.#writeEvidence({requestId, descriptor, agent, args: prepared.args, result, durationMs, era: agent.era});
    if (normalized.isError) {
      const out = this.#fail({
        code: 'TOOL_ERROR',
        message: normalized.text.slice(0, 2000) || '上游返回 isError: true',
        recovery: EXTERNAL_RECOVERY.TOOL_ERROR
      }, evidence, {readOnly: descriptor.readOnly, retryable: false});
      this.#emitEvidence(out, {agent, descriptor, idempotency: prepared.idempotency});
      return out;
    }

    const text = normalized.text;
    const truncated = byteLength(text) > this.maxModelBytes;
    const out = buildEnvelope({
      status: 'ok',
      data: {text, ...(normalized.structured ? {structured: normalized.structured} : {})},
      evidence,
      truncated,
      assets,
      readOnly: descriptor.readOnly,
      retryable: prepared.retryable,
      idempotency: prepared.idempotency
    });
    this.#emitEvidence(out, {agent, descriptor, idempotency: prepared.idempotency});
    return out;
  }
}

export {cancelledError as externalCancelledError, truncateEvidence as truncateExternalEvidence};
