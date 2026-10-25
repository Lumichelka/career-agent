// 对外入站 /mcp：实例开关、每 (user, client) 自签凭据、双时代服务。
// 身份只来自 Authorization: Bearer（网页 cookie 与实例口令都不能当入站凭据）；
// 工具定义来自统一注册表，调用落到凭据所属账号的数据目录。
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {Server, createMcpHandler} from '@modelcontextprotocol/server';
import {getTool, inboundTools} from '../tools/registry.mjs';

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
    tools: Array.isArray(record.tools) ? record.tools : []
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
  constructor({dataDir, accounts, callTool, getOrigin = () => 'http://127.0.0.1'}) {
    if (!dataDir) throw new Error('InboundMcp 需要 dataDir');
    this.dataDir = dataDir;
    this.accounts = accounts;
    this.callTool = callTool;
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

  async #statusJson(userId) {
    const list = await this.#loadClients(userId);
    const origin = this.getOrigin();
    const port = Number(new URL(origin).port) || 0;
    return {
      enabled: this.enabled,
      enabledAt: this.state.enabledAt || '',
      enabledBy: this.state.enabledBy?.name || '',
      url: origin + '/mcp',
      audience: audience(origin, port),
      clients: list.map(publicClient)
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
          warning: '开启后，持有本实例签发凭据的外部 AI 可以读取你的本机求职数据；凭据只属于你，关闭开关不会撤销已签凭据。'
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
      const record = {
        id: randomUUID(),
        name: clean,
        prefix: token.slice(0, PREFIX_CHARS),
        hash: hashToken(token),
        tools: inboundTools().map(tool => tool.name),
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
      record.tools = inboundTools().map(tool => tool.name);
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

  #createServer({authInfo} = {}) {
    const userId = authInfo?.extra?.userId;
    const server = new Server({name: 'career-agent', version: '3.0.0'}, {capabilities: {tools: {}}});
    server.setRequestHandler('tools/list', async () => ({
      // #38 在这里合并该用户启用 Agent 的上游工具（含写，命名 mcp__<agent>__<tool>）；
      // 上游 token 永不回传给第三方，转发调用要带 forwarded_client + client id。
      tools: inboundTools().map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.parameters,
        annotations: {
          readOnlyHint: tool.permission !== 'write',
          destructiveHint: tool.permission === 'write',
          openWorldHint: tool.handler.startsWith('search.') || tool.handler.startsWith('platform.')
        }
      }))
    }));
    server.setRequestHandler('tools/call', async request => {
      const {name, arguments: args = {}} = request.params || {};
      const tool = getTool(name);
      // 平台工具是任务内的登录型浏览器操作，没有入站任务就没有身份，按未知工具处理。
      if (!tool || tool.handler.startsWith('platform.')) throw new Error('未知工具：' + name);
      if (!userId) return {content: [{type: 'text', text: JSON.stringify({status: 'error', code: 'UNAUTHORIZED', message: '入站凭据没有绑定账号'})}], isError: true};
      let result;
      try { result = await this.callTool({userId, tool, name, args}); }
      catch (error) {
        result = {status: 'error', code: 'TOOL_FAILED', message: error.message || String(error)};
      }
      return {content: [{type: 'text', text: JSON.stringify(result)}], isError: result?.status === 'error'};
    });
    return server;
  }
}
