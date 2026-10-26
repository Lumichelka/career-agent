// 对外入站 /mcp：实例开关、每 (user, client) 自签凭据、双时代服务。
// 身份只来自 Authorization: Bearer（网页 cookie 与实例口令都不能当入站凭据）；
// 工具定义来自统一注册表，调用落到凭据所属账号的数据目录。
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {Server, createMcpHandler} from '@modelcontextprotocol/server';
import {getTool, inboundTools} from '../tools/registry.mjs';
import {EXTERNAL_PREFIX, EXTERNAL_RECOVERY, mergeToolSurface} from '../agents/tools.mjs';

const TOKEN_MARK = 'zxmcp_';
const TOKEN_HEX = 48;            // 24 字节随机数的十六进制长度
const PREFIX_CHARS = TOKEN_MARK.length + 8; // 够认出是哪一枚，不足以还原
const TOUCH_INTERVAL_MS = 30000; // 最近使用时间最多每 30 秒落盘一次

// 受众白名单是实例级策略，和开关一起落在 mcp-inbound.json：
// 只承诺本机回环与 Tailscale HTTPS，局域网明文与其它地址一律未验证。
const DEFAULT_AUDIENCE = {
  promised: ['loopback', 'tailscale-https'],
  loopbackHosts: ['127.0.0.1', 'localhost', '[::1]'],
  unverified: ['lan-plaintext', 'other-addresses']
};

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return TOKEN_MARK + randomBytes(TOKEN_HEX / 2).toString('hex');
}

// 只承诺本机回环与 Tailscale HTTPS；局域网明文与其它地址都算未验证，写在状态里也写在文档里。
export function audience(origin, port) {
  return {
    promised: [origin + '/mcp', 'Tailscale HTTPS（tailscale serve https 后的 https://<机器>.<tailnet>.ts.net/mcp）'],
    unverified: ['局域网明文 http://<局域网 IP>:' + port + '/mcp'],
    note: '只承诺本机回环与 Tailscale HTTPS 两种地址；局域网明文与未列出的地址未验证，不承诺可用。'
  };
}

// 三种宿主片段：Claude Code 用官方 CLI 形态，Cursor / VS Code 用 .mcp.json（mcpServers），
// Codex 只给 bearer_token_env_var——它明确拒绝内联 bearer_token，所以片段里绝不出现凭据。
export function hostSnippets({url, token, serverName = 'career-agent', envVar = 'CAREER_MCP_TOKEN'}) {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      format: 'shell',
      content: 'claude mcp add --transport http ' + serverName + ' ' + url + ' --header "Authorization: Bearer ' + token + '"'
    },
    {
      id: 'cursor-vscode',
      label: 'Cursor / VS Code（.mcp.json）',
      format: 'json',
      content: JSON.stringify({
        mcpServers: {[serverName]: {type: 'http', url, headers: {Authorization: 'Bearer ' + token}}}
      }, null, 2)
    },
    {
      id: 'codex',
      label: 'Codex（~/.codex/config.toml）',
      format: 'toml',
      envVar,
      note: '先在环境变量 ' + envVar + ' 里填入本次签发的凭据；Codex 不接受内联 bearer_token。',
      content: '[mcp_servers.' + serverName + ']\nurl = "' + url + '"\nbearer_token_env_var = "' + envVar + '"\n'
    }
  ];
}

function publicClient(record) {
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.prefix,
    createdAt: record.createdAt,
    regeneratedAt: record.regeneratedAt || '',
    lastUsedAt: record.lastUsedAt || '',
    revoked: !!record.revokedAt,
    revokedAt: record.revokedAt || '',
    consentAt: record.consentAt || '',
    toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
    tools: Array.isArray(record.tools) ? record.tools : [],
    // 签发后新出现的工具（本地升级或上游扩权）：只提示，凭据继续有效，绝不自动重发/撤销。
    newTools: [],
    newToolCount: 0
  };
}

function unauthorized(message, code = 'UNAUTHORIZED') {
  return new Response(JSON.stringify({error: message, code}), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer realm="career-agent", error="invalid_token"'
    }
  });
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export class InboundMcp {
  // callTool({userId, tool, name, args}) 由应用注入：入站调用要落到凭据所属账号的数据与配置上。
  // forward（#38）：{listTools(userId, {clientId, clientName}), callTool({userId, clientId, clientName, name, args, signal})}，
  // 转发到该用户启用的外部 Agent；不传时入站只暴露本地工具（#37 的行为）。
  // inFlight（#38）：{acquire(userId, {signal}) -> release}，入站转发调用计入该用户在途额度；
  // #36 的统一上游闸合并前，应用把它接到任务闸上（见 app.mjs 的显式接缝）。
  constructor({dataDir, accounts, callTool, getOrigin = () => 'http://127.0.0.1', forward = null, inFlight = null}) {
    if (!dataDir) throw new Error('InboundMcp 需要 dataDir');
    this.dataDir = dataDir;
    this.accounts = accounts;
    this.callTool = callTool;
    this.forward = forward;
    this.inFlight = inFlight;
    this.getOrigin = getOrigin;
    this.configFile = join(dataDir, 'mcp-inbound.json');
    this.state = {enabled: false};
    this.clients = new Map();   // userId -> client 记录数组
    this.index = new Map();     // token 哈希 -> {userId, clientId, name}
    this.writes = new Map();    // userId -> 串行写队列
    this.touched = new Map();   // token 哈希 -> 上次落盘最近使用时间
  }

  async init() {
    const raw = await readJson(this.configFile, {});
    this.state = {
      enabled: raw?.enabled === true,
      enabledAt: typeof raw?.enabledAt === 'string' ? raw.enabledAt : '',
      enabledBy: raw?.enabledBy && typeof raw.enabledBy === 'object'
        ? {id: String(raw.enabledBy.id || ''), name: String(raw.enabledBy.name || '')}
        : null,
      audience: raw?.audience && typeof raw.audience === 'object' ? raw.audience : DEFAULT_AUDIENCE
    };
    for (const user of this.accounts?.users || []) await this.#loadClients(user.id);
    this.mcp = createMcpHandler(ctx => this.#createServer(ctx), {
      onerror: error => { this.lastError = error?.message || String(error); }
    });
    return this;
  }

  get enabled() { return this.state.enabled === true; }

  async close() {
    if (this.mcp) await this.mcp.close().catch(() => {});
  }

  #file(userId) { return join(this.dataDir, 'users', userId, 'mcp-clients.json'); }

  async #loadClients(userId) {
    if (this.clients.has(userId)) return this.clients.get(userId);
    const raw = await readJson(this.#file(userId), []);
    const list = (Array.isArray(raw) ? raw : []).filter(c => c && typeof c.id === 'string' && /^[a-f0-9-]{36}$/.test(c.id) && typeof c.hash === 'string');
    this.clients.set(userId, list);
    for (const record of list) if (!record.revokedAt) this.index.set(record.hash, {userId, clientId: record.id, name: record.name});
    return list;
  }

  #queue(userId, fn) {
    const previous = this.writes.get(userId) || Promise.resolve();
    const next = previous.then(fn, fn);
    this.writes.set(userId, next.catch(() => {}));
    return next;
  }

  async #persist(userId) {
    const list = this.clients.get(userId) || [];
    const file = this.#file(userId);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, JSON.stringify(list, null, 2), 'utf8');
  }

  async #saveState() {
    await writeFile(this.configFile, JSON.stringify(this.state, null, 2), 'utf8');
  }

  // 当前工具面（本地 + 该用户启用 Agent 的上游，命名同出站）。
  // forward 不可用或上游连不上时只回本地工具：一个 Agent 挂掉不拖垮整个入站列表。
  async #currentNames(userId) {
    const names = inboundTools().map(tool => tool.name);
    if (!this.forward) return names;
    try {
      const surface = await this.forward.listTools(userId, {});
      for (const tool of surface?.tools || []) if (tool?.name) names.push(tool.name);
    } catch { /* 上游不可用不影响本地工具 */ }
    return names;
  }

  // 签发时快照 vs 当前工具：多出来的只提示（newTools），不重发凭据、不撤销。
  async #clientViews(userId) {
    const list = await this.#loadClients(userId);
    const current = await this.#currentNames(userId);
    return list.map(record => {
      const view = publicClient(record);
      const known = new Set(Array.isArray(record.tools) ? record.tools : []);
      view.newTools = current.filter(name => !known.has(name));
      view.newToolCount = view.newTools.length;
      return view;
    });
  }

  async #statusJson(userId) {
    const origin = this.getOrigin();
    const port = Number(new URL(origin).port) || 0;
    return {
      enabled: this.enabled,
      enabledAt: this.state.enabledAt || '',
      enabledBy: this.state.enabledBy?.name || '',
      url: origin + '/mcp',
      audience: audience(origin, port),
      clients: await this.#clientViews(userId)
    };
  }

  async status(userId) {
    return {status: 200, json: await this.#statusJson(userId)};
  }

  // 实例级总开关：默认关，关闭时 /mcp 一律 404；开启需要二次确认（confirm: true），
  // 关闭不级联撤销任何已签凭据。
  async setEnabled({enabled, confirm, user}) {
    if (typeof enabled !== 'boolean') return {status: 400, json: {code: 'INVALID_REQUEST', error: 'enabled 必须是布尔值'}};
    if (enabled === this.enabled) return {status: 200, json: await this.#statusJson(user.id)};
    if (enabled && confirm !== true) {
      return {
        status: 409,
        json: {
          code: 'NEEDS_CONFIRMATION',
          error: '开启对外 MCP 需要二次确认',
          warning: '开启后，持有本实例签发凭据的外部 AI 可以读取你的本机求职数据；如果你启用了外部 Agent，它们的工具也会并入入站列表，转发调用会把内容发给该 Agent（签发凭据即视为同意）。凭据只属于你，关闭开关不会撤销已签凭据。'
        }
      };
    }
    this.state = enabled
      ? {...this.state, enabled: true, enabledAt: new Date().toISOString(), enabledBy: {id: user.id, name: user.name}}
      : {...this.state, enabled: false};
    await this.#saveState();
    return {status: 200, json: await this.#statusJson(user.id)};
  }

  // 签发 = 首次同意：记录签发时刻与当时的工具集快照；完整凭据只返回这一次，之后只显前缀。
  async issueClient({userId, name}) {
    const clean = String(name ?? '').trim();
    if (!clean || clean.length > 40 || /[\u0000-\u001f]/.test(clean)) {
      return {status: 400, json: {code: 'INVALID_CLIENT_NAME', error: 'client 名称需为 1 到 40 个可打印字符'}};
    }
    return this.#queue(userId, async () => {
      const list = await this.#loadClients(userId);
      if (list.some(c => !c.revokedAt && String(c.name).toLowerCase() === clean.toLowerCase())) {
        return {status: 409, json: {code: 'DUPLICATE_CLIENT_NAME', error: '已有同名的 client；请换一个名称，或对原凭据重新生成'}};
      }
      const token = newToken();
      const now = new Date().toISOString();
      // 签发即首次同意：记录当时的完整工具集快照（本地 + 已启用上游），之后扩权只提示。
      const snapshot = await this.#currentNames(userId);
      const record = {
        id: randomUUID(),
        name: clean,
        prefix: token.slice(0, PREFIX_CHARS),
        hash: hashToken(token),
        tools: snapshot,
        createdAt: now,
        consentAt: now,
        lastUsedAt: '',
        revokedAt: ''
      };
      list.push(record);
      await this.#persist(userId);
      this.index.set(record.hash, {userId, clientId: record.id, name: record.name});
      const url = this.getOrigin() + '/mcp';
      return {status: 200, json: {client: publicClient(record), token, snippets: hostSnippets({url, token})}};
    });
  }

  async revokeClient({userId, id}) {
    return this.#queue(userId, async () => {
      const list = await this.#loadClients(userId);
      const record = list.find(c => c.id === id);
      if (!record) return {status: 404, json: {code: 'CLIENT_NOT_FOUND', error: '没有这个 client'}};
      if (!record.revokedAt) {
        record.revokedAt = new Date().toISOString();
        this.index.delete(record.hash);
        await this.#persist(userId);
      }
      return {status: 200, json: {client: publicClient(record)}};
    });
  }

  // 重新生成会换掉这一枚 client 的凭据：旧 token 立即失效，client 身份与工具集快照保持不变。
  async regenerateClient({userId, id}) {
    return this.#queue(userId, async () => {
      const list = await this.#loadClients(userId);
      const record = list.find(c => c.id === id);
      if (!record) return {status: 404, json: {code: 'CLIENT_NOT_FOUND', error: '没有这个 client'}};
      if (record.revokedAt) return {status: 409, json: {code: 'CLIENT_REVOKED', error: '该 client 已撤销；请新建一枚凭据'}};
      this.index.delete(record.hash);
      const token = newToken();
      record.hash = hashToken(token);
      record.prefix = token.slice(0, PREFIX_CHARS);
      record.regeneratedAt = new Date().toISOString();
      record.tools = await this.#currentNames(userId);
      await this.#persist(userId);
      this.index.set(record.hash, {userId, clientId: record.id, name: record.name});
      const url = this.getOrigin() + '/mcp';
      return {status: 200, json: {client: publicClient(record), token, snippets: hostSnippets({url, token})}};
    });
  }

  // 认证只认 Authorization: Bearer；cookie、实例口令、x-career-token 都不是入站身份。
  authenticate(header) {
    const match = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
    if (!match) return null;
    const hash = hashToken(match[1]);
    const entry = this.index.get(hash);
    if (!entry) return null;
    return {token: match[1], hash, ...entry};
  }

  #touch(auth) {
    return this.#queue(auth.userId, async () => {
      const now = Date.now();
      const list = await this.#loadClients(auth.userId);
      const record = list.find(c => c.id === auth.clientId && c.hash === auth.hash && !c.revokedAt);
      if (!record) return;
      record.lastUsedAt = new Date(now).toISOString();
      if (now - (this.touched.get(auth.hash) || 0) < TOUCH_INTERVAL_MS) return;
      this.touched.set(auth.hash, now);
      await this.#persist(auth.userId);
    });
  }

  // 返回 null 表示开关关闭（调用方回 404）；否则总是返回一个 Response。
  async handle(request) {
    if (!this.enabled) return null;
    const auth = this.authenticate(request.headers.get('authorization'));
    if (!auth) return unauthorized('缺少或无效的入站凭据', 'UNAUTHORIZED');
    await this.#touch(auth).catch(() => {});
    return this.mcp.fetch(request, {
      authInfo: {
        token: auth.token,
        clientId: auth.clientId,
        scopes: [],
        extra: {userId: auth.userId, clientName: auth.name}
      }
    });
  }

  // 本地工具定义：参数仍来自统一注册表；写工具用 readOnlyHint=false 标出来。
  #localToolDefs() {
    return inboundTools().map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: {
        readOnlyHint: tool.permission !== 'write',
        destructiveHint: tool.permission === 'write',
        openWorldHint: tool.handler.startsWith('search.') || tool.handler.startsWith('platform.')
      }
    }));
  }

  // 上游工具定义：命名已在 #35 的 ExternalToolset 里按 mcp__<agentSlug>__<tool> 生成；只读分级用上游注解。
  async #upstreamToolDefs(userId, clientId, clientName) {
    if (!this.forward || !userId) return [];
    let surface = null;
    try { surface = await this.forward.listTools(userId, {clientId, clientName}); }
    catch { return []; }
    return (surface?.tools || []).filter(tool => tool && typeof tool.name === 'string').map(tool => ({
      name: tool.name,
      title: tool.title || '外部 Agent 工具',
      description: tool.description || '',
      inputSchema: tool.parameters || {type: 'object', properties: {}},
      annotations: {
        readOnlyHint: tool.readOnly === true,
        destructiveHint: tool.readOnly !== true,
        openWorldHint: true
      }
    }));
  }

  #result(result) {
    return {content: [{type: 'text', text: JSON.stringify(result)}], isError: result?.status === 'error'};
  }

  // 转发失败也回 #35 的信封：固定错误码 + 恢复建议，且来源可认出是哪个 client。
  #forwardError(code, message, {clientId = '', clientName = ''} = {}) {
    return {
      status: 'error',
      error: {code, message, recovery: EXTERNAL_RECOVERY[code] || EXTERNAL_RECOVERY.UPSTREAM_ERROR},
      evidence: {actorType: 'forwarded_client', actorRef: clientId, ...(clientId ? {clientId} : {}), ...(clientName ? {clientName} : {})},
      readOnly: false,
      retryable: false
    };
  }

  #createServer({authInfo} = {}) {
    const userId = authInfo?.extra?.userId;
    const clientId = authInfo?.clientId || '';
    const clientName = authInfo?.extra?.clientName || '';
    const server = new Server({name: 'career-agent', version: '3.0.0'}, {capabilities: {tools: {}}});
    server.setRequestHandler('tools/list', async () => ({
      // #38：本地注册表在前，该用户启用 Agent 的上游工具（含写）按 Agent 名追加，命名与出站一致。
      // 上游 token 永不回传给第三方；任务内快照不约束入站列表，每次按连接缓存/刷新后的工具面给。
      tools: mergeToolSurface(this.#localToolDefs(), await this.#upstreamToolDefs(userId, clientId, clientName))
    }));
    server.setRequestHandler('tools/call', async request => {
      const {name, arguments: args = {}} = request.params || {};
      if (!userId) return this.#result({status: 'error', code: 'UNAUTHORIZED', message: '入站凭据没有绑定账号'});
      const tool = getTool(name);
      // 平台工具是任务内的登录型浏览器操作，没有入站任务就没有身份，按未知工具处理。
      if (tool) {
        if (tool.handler.startsWith('platform.')) throw new Error('未知工具：' + name);
        // 本地工具（含写）落到该账号的数据目录：写工具带 forwarded_client + client id，
        // 敏感写照常返回 confirm_required，确认只能由本应用 UI 完成。
        let result;
        try { result = await this.callTool({userId, clientId, clientName, tool, name, args}); }
        catch (error) {
          result = {status: 'error', code: 'TOOL_FAILED', message: error.message || String(error)};
        }
        return this.#result(result);
      }
      // 上游工具：命名空间前缀必须对得上，否则仍按未知工具处理（不回显任何上游细节）。
      if (!String(name || '').startsWith(EXTERNAL_PREFIX) || !this.forward) throw new Error('未知工具：' + name);
      let release = null;
      try {
        // 入站转发调用计入该用户在途额度；#36 的统一上游闸合并前，这里接应用注入的闸（见 app.mjs）。
        if (this.inFlight) {
          try { release = await this.inFlight.acquire(userId); }
          catch (error) {
            return this.#result(this.#forwardError('QUEUE_TIMEOUT', error?.message || '所有上游调用都在忙，已排队超时。', {clientId, clientName}));
          }
        }
        const envelope = await this.forward.callTool({userId, clientId, clientName, name, args, signal: AbortSignal.timeout(300000)});
        return this.#result(envelope);
      } finally {
        if (release) release();
      }
    });
    return server;
  }
}
