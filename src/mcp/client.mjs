// 外部 MCP Agent 的连接生命周期：每 (用户, Agent) 一条懒连接、空闲 30 分钟回收、
// 断线退避重连（1s / 5s / 30s，最多 3 次 / 10 分钟）、发现缓存 10 分钟 + 任务快照 pin。
// 传输与 SDK 细节都在本模块；上层只拿到状态、工具与 callTool 接缝（#35 用）。
// 测试注入 createConnection：绝不启动真实外部 Agent，也不联网。
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {spawn} from 'node:child_process';

export const MAX_AGENTS = 10;
export const TOOL_CACHE_MS = 10 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
export const RECONNECT_DELAYS_MS = [1000, 5000, 30000];
export const RECONNECT_WINDOW_MS = 10 * 60 * 1000;
export const RECONNECT_MAX = 3;
export const DISCOVERY_MAX = 10 * 1024 * 1024;
export const AGENT_STATES = ['disconnected', 'connecting', 'connected', 'failed', 'closed', 'queued'];

export const ERROR_RECOVERY = {
  CONNECT_FAILED: '检查命令或 URL、网络与上游是否在运行，然后点「重试连接」。',
  AUTH_FAILED: '更新 Bearer token 或自定义 header；本应用不实现 OAuth，401/403 不会自动刷新。',
  ERA_NEGOTIATION_FAILED: '确认上游是 MCP server 并支持 Streamable HTTP；换传输或换入口后再试。',
  REQUEST_TIMEOUT: '上游响应超时：缩小输入、稍后重试，或换一个 Agent。',
  UPSTREAM_ERROR: '连接已建立但调用/发现失败：查看上游日志后重试。',
  AGENT_DISABLED: '先在配置里启用这个 Agent。'
};

export class AgentConnectionError extends Error {
  constructor(code, message, {status = 400, recovery = '', retryInMs = 0, exhausted = false} = {}) {
    super(message);
    this.name = 'AgentConnectionError';
    this.code = code;
    this.status = status;
    this.recovery = recovery || ERROR_RECOVERY[code] || '';
    this.retryInMs = retryInMs;
    this.exhausted = exhausted;
  }
}

// 错误消息里可能出现上游 URL：去掉用户信息与查询串，别把凭据写进状态、配置或日志。
export function sanitizeErrorMessage(text) {
  return String(text || '').replace(/https?:\/\/[^\s"'<>]+/g, raw => {
    try {
      const u = new URL(raw);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch { return raw; }
  });
}

// 连接失败面按契约 §2.1 / §8.3 映射成固定错误码与恢复建议。
export function mapConnectionError(error) {
  const message = sanitizeErrorMessage(error?.message || error || '连接失败');
  const code = String(error?.code || error?.cause?.code || '');
  const status = Number(error?.data?.status || error?.status || 0);
  const text = code + ' ' + message;
  if (status === 401 || status === 403 || /CLIENT_HTTP_AUTHENTICATION|UNAUTHOR|FORBIDDEN|\b401\b|\b403\b|invalid.?token|api.?key/i.test(text)) {
    return {code: 'AUTH_FAILED', message, recovery: ERROR_RECOVERY.AUTH_FAILED};
  }
  if (/ERA_NEGOTIATION|UNSUPPORTED_PROTOCOL|PROTOCOL_VERSION|EraNegotiation/i.test(text)) {
    return {code: 'ERA_NEGOTIATION_FAILED', message, recovery: ERROR_RECOVERY.ERA_NEGOTIATION_FAILED};
  }
  if (/TIMEOUT|ETIMEDOUT|timed out|timeout|AbortError|aborted/i.test(text)) {
    return {code: 'REQUEST_TIMEOUT', message, recovery: ERROR_RECOVERY.REQUEST_TIMEOUT};
  }
  return {code: 'CONNECT_FAILED', message, recovery: ERROR_RECOVERY.CONNECT_FAILED};
}

export function mapDiscoveryError(error) {
  const mapped = mapConnectionError(error);
  if (mapped.code === 'CONNECT_FAILED') return {code: 'UPSTREAM_ERROR', message: mapped.message, recovery: ERROR_RECOVERY.UPSTREAM_ERROR};
  return mapped;
}

const SECRET_ENV = /^(CAREER_|MODEL_API_KEY$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/i;
const PROXY_ENV = /^(https?|all|no)_proxy$/i;

// stdio 子进程环境：只注入该 Agent 自己的变量，绝不继承 CAREER_*、模型 Key、bridge token 或代理设置。
export function safeStdioEnv(userEnv = {}) {
  const out = {};
  for (const [key, value] of Object.entries(userEnv || {})) {
    if (typeof value !== 'string') continue;
    if (SECRET_ENV.test(key) || PROXY_ENV.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// shell: false（SDK 内部固定），cwd 锁在该用户目录；命令与参数分开传，不拼接字符串。
export function stdioSpawnOptions(agent, home, credentials = {}) {
  return {
    command: agent.stdio?.command || '',
    args: Array.isArray(agent.stdio?.args) ? [...agent.stdio.args] : [],
    env: safeStdioEnv(credentials.env),
    cwd: home,
    stderr: 'pipe',
    maxBufferSize: DISCOVERY_MAX,
    shell: false
  };
}

function basicAuthHeader(username, password) {
  const user = decodeURIComponent(String(username || ''));
  const pass = decodeURIComponent(String(password || ''));
  return 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64');
}

// HTTP 凭据：Bearer 走 authProvider；自定义 header 与 URL 用户信息都只在服务端注入。
export function httpTransportOptions(credentials = {}) {
  const url = new URL(credentials.url);
  const headers = {};
  if (url.username || url.password) {
    headers.Authorization = basicAuthHeader(url.username, url.password);
    url.username = '';
    url.password = '';
  }
  if (credentials.headerName && credentials.headerValue) headers[credentials.headerName] = credentials.headerValue;
  const options = {requestInit: {headers}};
  if (credentials.token) options.authProvider = {token: async () => credentials.token};
  return {url, options};
}

// 统一 kill 路径：Windows 用 taskkill /PID <pid> /T /F（拿不到 Job Object 时的兜底），
// POSIX 先给进程组 SIGTERM，2 秒后 SIGKILL；空闲回收、取消、超时、进程退出都走这里。
export async function killProcessTree({
  pid,
  platform = process.platform,
  run = runCommand,
  kill = process.kill.bind(process),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  graceMs = 2000
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return {killed: false, method: 'none'};
  if (platform === 'win32') {
    const result = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return {killed: result.code === 0, method: 'taskkill', code: result.code};
  }
  let grouped = true;
  try { kill(-pid, 'SIGTERM'); } catch { grouped = false; }
  if (!grouped) { try { kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  await sleep(graceMs);
  try { kill(-pid, 'SIGKILL'); } catch { try { kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  return {killed: true, method: grouped ? 'process-group' : 'pid'};
}

function runCommand(command, args) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, {shell: false, windowsHide: true, stdio: 'ignore'}); }
    catch { resolve({code: -1}); return; }
    child.on('error', () => resolve({code: -1}));
    child.on('close', code => resolve({code: Number.isInteger(code) ? code : -1}));
  });
}

// 默认连接：@modelcontextprotocol/client 2.4.0，auto 协商现代/legacy 两个时代。
export async function createSdkConnection({agent, home, credentials, mrtr, handlers = {}, platform = process.platform}) {
  const capabilities = {};
  if (mrtr?.sampling !== false) capabilities.sampling = {};
  if (mrtr?.elicitation !== false) capabilities.elicitation = {};
  capabilities.roots = {};
  const client = new Client({name: 'career-agent', version: '3.0.0'}, {
    versionNegotiation: {mode: 'auto'},
    inputRequired: {autoFulfill: true, maxRounds: 3},
    capabilities
  });
  const register = (method, handler) => {
    if (typeof handler === 'function') client.setRequestHandler(method, handler);
  };
  if (mrtr?.sampling !== false) register('sampling/createMessage', handlers.sampling);
  if (mrtr?.elicitation !== false) register('elicitation/create', handlers.elicitation);
  register('roots/list', handlers.roots);
  let transport = null;
  let pid = null;
  let closed = false;
  if (agent.transport === 'stdio') {
    transport = new StdioClientTransport(stdioSpawnOptions(agent, home, credentials));
  } else {
    const {url, options} = httpTransportOptions(credentials);
    transport = new StreamableHTTPClientTransport(url, options);
  }
  await client.connect(transport);
  pid = transport.pid ?? null;
  return {
    pid,
    era: () => client.getProtocolEra() || '',
    serverInfo: () => {
      const info = client.getServerVersion();
      return info ? {name: info.name || '', version: info.version || ''} : null;
    },
    listTools: () => client.listTools(),
    callTool: (name, args, options) => client.callTool({name, arguments: args || {}}, options),
    close: async () => {
      if (closed) return;
      closed = true;
      // Windows 先 taskkill /T 再关传输，避免 npx/.cmd 留下孤儿；POSIX 交给传输关完再清进程组。
      let killResult = null;
      if (platform === 'win32' && pid) killResult = await killProcessTree({pid, platform}).catch(() => null);
      await client.close().catch(() => {});
      if (platform !== 'win32' && pid) killResult = await killProcessTree({pid, platform}).catch(() => null);
      return killResult;
    }
  };
}

function normalizeTools(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.filter(tool => tool && typeof tool.name === 'string').map(tool => ({
    name: tool.name,
    title: tool.title || '',
    description: tool.description || '',
    // 分级只认 readOnlyHint === true，其余（含缺省）都按写；注解不参与授权。
    readOnly: tool.annotations?.readOnlyHint === true,
    // #35 的工具面需要上游 inputSchema（参数校验、幂等键字段探测）与原始注解快照。
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null,
    annotations: tool.annotations && typeof tool.annotations === 'object' ? {...tool.annotations} : null
  }));
}

function iso(ms) { return ms ? new Date(ms).toISOString() : ''; }

export class AgentConnectionManager {
  constructor({
    home,
    config,
    createConnection = createSdkConnection,
    now = () => Date.now(),
    timer = defaultTimer(),
    platform = process.platform,
    idleMs = IDLE_MS,
    toolsTtlMs = TOOL_CACHE_MS,
    reconnectDelays = RECONNECT_DELAYS_MS,
    reconnectWindowMs = RECONNECT_WINDOW_MS,
    reconnectMax = RECONNECT_MAX,
    handlers = {}
  } = {}) {
    if (!home || !config) throw new Error('AgentConnectionManager 需要 home 与 AgentConfig');
    this.home = home;
    this.config = config;
    this.createConnection = createConnection;
    this.now = now;
    this.timer = timer;
    this.platform = platform;
    this.idleMs = idleMs;
    this.toolsTtlMs = toolsTtlMs;
    this.reconnectDelays = reconnectDelays;
    this.reconnectWindowMs = reconnectWindowMs;
    this.reconnectMax = reconnectMax;
    this.handlers = handlers;
    this.records = new Map();
    this.closed = false;
  }

  #record(agent) {
    let record = this.records.get(agent.id);
    if (!record) {
      record = {
        id: agent.id,
        state: agent.lastError ? 'failed' : 'disconnected',
        connection: null,
        connecting: null,
        era: agent.lastEra || '',
        serverInfo: null,
        lastConnectedAt: agent.lastConnectedAt || '',
        lastError: agent.lastError || null,
        tools: [],
        toolsAt: 0,
        pinned: null,
        pinnedAt: 0,
        lastActivity: this.now(),
        attempts: [],
        nextRetryAt: 0,
        closedAt: 0,
        idleTimer: null
      };
      this.records.set(agent.id, record);
    }
    return record;
  }

  #touch(record) {
    record.lastActivity = this.now();
    this.#scheduleIdle(record);
  }

  #scheduleIdle(record) {
    if (record.idleTimer != null) this.timer.clearTimeout(record.idleTimer);
    record.idleTimer = this.timer.setTimeout(() => { this.reapIdle().catch(() => {}); }, this.idleMs + 1);
  }

  #error(record, mapped, {retryInMs = 0, exhausted = false} = {}) {
    return new AgentConnectionError(mapped.code, mapped.message, {recovery: mapped.recovery, retryInMs, exhausted});
  }

  #recentAttempts(record, now) {
    record.attempts = record.attempts.filter(at => now - at < this.reconnectWindowMs);
    return record.attempts;
  }

  async connect(id, {force = false} = {}) {
    const agent = this.agentFromConfig(id);
    if (!agent) throw new AgentConnectionError('AGENT_NOT_FOUND', '没有这个外部 Agent', {status: 404});
    if (agent.enabled === false) throw new AgentConnectionError('AGENT_DISABLED', '这个外部 Agent 已停用', {status: 409});
    const record = this.#record(agent);
    if (record.connection && record.state === 'connected') { this.#touch(record); return this.statusOf(agent, record); }
    if (record.connecting) {
      const previous = record.state;
      record.state = 'queued';
      try { await record.connecting; }
      finally { if (record.connection && record.state === 'queued') record.state = 'connected'; else if (record.state === 'queued') record.state = previous; }
      if (record.state === 'connected') this.#touch(record);
      return this.statusOf(agent, record);
    }
    const now = this.now();
    const recent = this.#recentAttempts(record, now);
    if (!force && record.state === 'failed') {
      if (recent.length >= this.reconnectMax) {
        throw this.#error(record, record.lastError || {code: 'CONNECT_FAILED', message: '重连次数已达上限', recovery: ERROR_RECOVERY.CONNECT_FAILED}, {exhausted: true});
      }
      if (now < record.nextRetryAt) {
        throw this.#error(record, record.lastError || {code: 'CONNECT_FAILED', message: '连接失败', recovery: ERROR_RECOVERY.CONNECT_FAILED}, {retryInMs: record.nextRetryAt - now});
      }
    }
    record.state = 'connecting';
    record.lastError = null;
    record.connecting = (async () => {
      let connection = null;
      try {
        connection = await this.createConnection({
          agent: this.configPublicAgent(agent),
          home: this.home,
          credentials: this.config.credentialsFor(agent.id),
          mrtr: agent.mrtr || {sampling: true, elicitation: true},
          handlers: this.handlers,
          platform: this.platform
        });
        await connection.connect?.();
        record.connection = connection;
        record.state = 'connected';
        record.era = String(connection.era?.() || '');
        record.serverInfo = connection.serverInfo?.() || null;
        record.lastConnectedAt = iso(this.now());
        record.lastError = null;
        record.nextRetryAt = 0;
        await this.config.markConnected(agent.id, {era: record.era, at: record.lastConnectedAt}).catch(() => {});
        this.#touch(record);
        return record;
      } catch (error) {
        try { await connection?.close?.(); } catch { /* 尽力回收 */ }
        record.connection = null;
        const mapped = mapConnectionError(error);
        record.lastError = mapped;
        record.state = 'failed';
        record.attempts.push(this.now());
        const index = Math.min(record.attempts.length - 1, this.reconnectDelays.length - 1);
        record.nextRetryAt = this.now() + (this.reconnectDelays[index] || 0);
        await this.config.markError(agent.id, mapped).catch(() => {});
        throw this.#error(record, mapped, {retryInMs: this.reconnectDelays[index] || 0, exhausted: this.#recentAttempts(record, this.now()).length >= this.reconnectMax});
      } finally {
        record.connecting = null;
      }
    })();
    await record.connecting;
    return this.statusOf(agent, record);
  }

  // 配置里的完整记录（含凭据键名），连接工厂只需要非密字段；凭据单独从 credentialsFor 取。
  configPublicAgent(agent) {
    return {
      id: agent.id,
      name: agent.name,
      transport: agent.transport,
      enabled: agent.enabled !== false,
      stdio: agent.stdio ? {command: agent.stdio.command, args: [...(agent.stdio.args || [])]} : null,
      http: agent.http ? {url: agent.http.url, allowPrivateHttp: agent.http.allowPrivateHttp === true, headerName: agent.http.headerName || ''} : null
    };
  }

  agentFromConfig(id) {
    return this.config.agents.find(agent => agent.id === id) || null;
  }

  async #discover(record, agent, {force = true} = {}) {
    if (!record.connection) await this.connect(agent.id);
    const now = this.now();
    if (!force && record.toolsAt && now - record.toolsAt < this.toolsTtlMs && record.tools.length) return record.tools.map(tool => ({...tool}));
    let result;
    try { result = await record.connection.listTools(); }
    catch (error) {
      const mapped = mapDiscoveryError(error);
      record.lastError = mapped;
      record.state = 'failed';
      const connection = record.connection;
      record.connection = null;
      try { await connection?.close?.(); } catch { /* 尽力回收 */ }
      await this.config.markError(agent.id, mapped).catch(() => {});
      throw this.#error(record, mapped);
    }
    record.tools = normalizeTools(result);
    record.toolsAt = this.now();
    this.#touch(record);
    return record.tools.map(tool => ({...tool}));
  }

  async tools(id, {force = false} = {}) {
    const agent = this.agentFromConfig(id);
    if (!agent) throw new AgentConnectionError('AGENT_NOT_FOUND', '没有这个外部 Agent', {status: 404});
    const record = this.#record(agent);
    return this.#discover(record, agent, {force});
  }

  async refresh(id) {
    const tools = await this.tools(id, {force: true});
    return {...this.statusOf(this.agentFromConfig(id), this.records.get(id)), tools};
  }

  // #35 用完即丢的任务快照：pin 之后任务中途上游增删工具，不影响本次任务。
  async pin(id) {
    const tools = await this.tools(id);
    const record = this.records.get(id);
    record.pinned = tools;
    record.pinnedAt = this.now();
    return tools.map(tool => ({...tool}));
  }

  pinned(id) {
    const record = this.records.get(id);
    return record?.pinned ? record.pinned.map(tool => ({...tool})) : null;
  }

  // 测试连接：只 connect + 发现，绝不调用任何工具。
  async test(id) {
    const agent = this.agentFromConfig(id);
    if (!agent) throw new AgentConnectionError('AGENT_NOT_FOUND', '没有这个外部 Agent', {status: 404});
    const record = this.#record(agent);
    if (!record.connection) await this.connect(id, {force: true});
    const tools = await this.#discover(record, agent, {force: true});
    return {...this.statusOf(agent, record), tools};
  }

  async reconnect(id) {
    const agent = this.agentFromConfig(id);
    if (!agent) throw new AgentConnectionError('AGENT_NOT_FOUND', '没有这个外部 Agent', {status: 404});
    const record = this.#record(agent);
    await this.#close(record, 'reconnect');
    record.state = 'disconnected';
    record.attempts = [];
    record.nextRetryAt = 0;
    record.lastError = null;
    await this.connect(id, {force: true});
    return this.statusOf(agent, record);
  }

  // #35 的调用接缝：不在这里做统一工具面/证据信封，只把原始 MCP 调用接出去。
  async callTool(id, name, args = {}, options = {}) {
    const agent = this.agentFromConfig(id);
    if (!agent) throw new AgentConnectionError('AGENT_NOT_FOUND', '没有这个外部 Agent', {status: 404});
    const record = this.#record(agent);
    if (!record.connection) await this.connect(id);
    this.#touch(record);
    try {
      return await record.connection.callTool(name, args, options);
    } catch (error) {
      const mapped = mapConnectionError(error);
      throw new AgentConnectionError(mapped.code === 'CONNECT_FAILED' ? 'UPSTREAM_ERROR' : mapped.code, mapped.message, {recovery: ERROR_RECOVERY.UPSTREAM_ERROR});
    }
  }

  async #close(record, reason) {
    if (record.idleTimer != null) { this.timer.clearTimeout(record.idleTimer); record.idleTimer = null; }
    const connection = record.connection;
    record.connection = null;
    try { await connection?.close?.(); } catch { /* 回收失败不影响状态 */ }
    if (connection) record.closedAt = this.now();
    record.closedReason = reason;
    return true;
  }

  async disconnect(id, reason = 'manual') {
    const agent = this.agentFromConfig(id);
    if (!agent) return false;
    const record = this.#record(agent);
    await this.#close(record, reason);
    record.state = 'closed';
    return true;
  }

  // 空闲回收：连接与子进程关闭，发现缓存与 pin 保留；下一次调用自动重连。
  async reapIdle() {
    const now = this.now();
    let reaped = 0;
    for (const record of this.records.values()) {
      if (!record.connection || record.state !== 'connected') continue;
      if (now - record.lastActivity < this.idleMs) continue;
      await this.#close(record, 'idle');
      record.state = 'closed';
      reaped += 1;
    }
    return reaped;
  }

  async forget(id) {
    const record = this.records.get(id);
    if (!record) return;
    await this.#close(record, 'removed');
    this.records.delete(id);
  }

  statusOf(agent, record) {
    const now = this.now();
    const recent = this.#recentAttempts(record, now);
    const retryInMs = record.state === 'failed' && record.nextRetryAt > now ? record.nextRetryAt - now : 0;
    return {
      id: agent.id,
      name: agent.name,
      transport: agent.transport,
      enabled: agent.enabled !== false,
      mrtr: agent.mrtr || {sampling: true, elicitation: true},
      state: this.closed ? 'closed' : record.state,
      era: record.era || '',
      serverInfo: record.serverInfo || null,
      lastConnectedAt: record.lastConnectedAt || '',
      lastEra: record.era || agent.lastEra || '',
      lastError: record.lastError || null,
      tools: record.tools.map(tool => ({...tool})),
      toolsCachedAt: iso(record.toolsAt),
      pinnedAt: iso(record.pinnedAt),
      closedAt: iso(record.closedAt),
      closedReason: record.closedReason || '',
      retryInMs,
      retryExhausted: recent.length >= this.reconnectMax
    };
  }

  async status(id) {
    await this.reapIdle();
    const agent = this.agentFromConfig(id);
    if (!agent) return null;
    return this.statusOf(agent, this.#record(agent));
  }

  async statuses() {
    await this.reapIdle();
    return this.config.agents.map(agent => this.statusOf(agent, this.#record(agent)));
  }

  async closeAll() {
    this.closed = true;
    const records = [...this.records.values()];
    await Promise.all(records.map(record => this.#close(record, 'shutdown').catch(() => {})));
  }
}

function defaultTimer() {
  return {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    },
    clearTimeout(handle) { clearTimeout(handle); }
  };
}
