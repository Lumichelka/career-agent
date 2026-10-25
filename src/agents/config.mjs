// 外部 Agent 配置（每用户一份）：非密配置存 users/<id>/.data/agents.json，
// 凭据（token、自定义 header 值、带用户信息或查询串的 URL、stdio 环境变量值）只进该用户的 KeyVault。
// 公开视图永远只给掩码：URL 去掉用户信息与查询串，token 只回 hasToken。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {uuidv7} from '../writes/gateway.mjs';
import {validateEndpoint} from '../model/model-settings.mjs';
import {isPrivateHostname} from '../model/providers.mjs';

export const MAX_AGENTS = 10;
export const AGENT_TRANSPORTS = ['stdio', 'http'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class AgentConfigError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

// URL 里的用户信息或查询串按凭据处理：校验只针对去掉凭据后的地址，整条原件进 vault。
export function splitHttpUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new AgentConfigError('INVALID_URL', '请填写外部 Agent 的 URL');
  let u;
  try { u = new URL(text); } catch { throw new AgentConfigError('INVALID_URL', 'URL 不是合法地址（要带 http:// 或 https://）'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new AgentConfigError('INVALID_URL', 'URL 只支持 http 或 https');
  if (u.hash) throw new AgentConfigError('INVALID_URL', 'URL 不要带 # 片段');
  const hasUserInfo = !!(u.username || u.password);
  const hasQuery = !!u.search;
  const bare = new URL(text);
  bare.username = '';
  bare.password = '';
  bare.search = '';
  bare.hash = '';
  return {raw: text, bare: bare.toString(), hasUserInfo, hasQuery};
}

export function maskAgentUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new AgentConfigError('INVALID_NAME', '请填写 Agent 名称');
  if (name.length > 40) throw new AgentConfigError('INVALID_NAME', 'Agent 名称需为 1 到 40 个字符');
  if (CONTROL.test(name)) throw new AgentConfigError('INVALID_NAME', 'Agent 名称不能包含控制字符');
  return name;
}

function cleanArgs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AgentConfigError('INVALID_ARGS', '参数必须是字符串数组（shell: false，不拼接命令）');
  if (raw.length > 64) throw new AgentConfigError('INVALID_ARGS', '参数最多 64 个');
  return raw.map(item => {
    const value = String(item);
    if (value.length > 500 || CONTROL.test(value)) throw new AgentConfigError('INVALID_ARGS', '单个参数需为 500 字以内的可打印文本');
    return value;
  });
}

function cleanEnv(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AgentConfigError('INVALID_ENV', '环境变量必须是对象');
  const out = {};
  const entries = Object.entries(raw);
  if (entries.length > 32) throw new AgentConfigError('INVALID_ENV', '环境变量最多 32 个');
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw new AgentConfigError('INVALID_ENV', '环境变量名不合法：' + key);
    if (/^CAREER_/i.test(key)) throw new AgentConfigError('INVALID_ENV', 'CAREER_* 变量不会注入外部 Agent：' + key);
    if (/^(https?|all|no)_proxy$/i.test(key)) throw new AgentConfigError('INVALID_ENV', '不继承代理设置：' + key);
    if (typeof value !== 'string' || value.length > 4000 || CONTROL.test(value)) throw new AgentConfigError('INVALID_ENV', '环境变量值需为 4000 字以内的文本：' + key);
    out[key] = value;
  }
  return out;
}

function cleanMrtr(raw, fallback = {sampling: true, elicitation: true}) {
  if (raw === undefined || raw === null) return {...fallback};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AgentConfigError('INVALID_MRTR', 'MRTR 开关必须是对象');
  return {
    sampling: raw.sampling === undefined ? true : raw.sampling === true,
    elicitation: raw.elicitation === undefined ? true : raw.elicitation === true
  };
}

function cleanHeaderName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return '';
  if (!HEADER_NAME.test(name)) throw new AgentConfigError('INVALID_HEADER', '自定义 header 名不合法');
  return name;
}

export class AgentConfig {
  constructor(home, vault = null) {
    if (!home) throw new Error('AgentConfig 需要该用户的 home 目录');
    this.home = home;
    this.dataDir = join(home, '.data');
    this.file = join(this.dataDir, 'agents.json');
    this.vault = vault;
    this.agents = [];
    this.writes = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const list = Array.isArray(raw?.agents) ? raw.agents : [];
      this.agents = list.filter(item => item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) && AGENT_TRANSPORTS.includes(item.transport));
    } catch { /* 首次运行或配置损坏：从空列表开始，不阻断启动 */ }
    return this;
  }

  #queue(fn) {
    const next = this.writes.then(fn, fn);
    this.writes = next.catch(() => {});
    return next;
  }

  async #save() {
    await mkdir(dirname(this.file), {recursive: true});
    await writeFile(this.file, JSON.stringify({version: 1, agents: this.agents}, null, 2), 'utf8');
  }

  #find(id) {
    return this.agents.find(agent => agent.id === String(id || '')) || null;
  }

  #require(id) {
    const agent = this.#find(id);
    if (!agent) throw new AgentConfigError('AGENT_NOT_FOUND', '没有这个外部 Agent', 404);
    return agent;
  }

  #key(id, suffix) { return 'agent.' + id + '.' + suffix; }

  async #clearVault(id) {
    if (!this.vault) return;
    const prefix = 'agent.' + id + '.';
    for (const name of this.vault.labels().filter(item => item.startsWith(prefix))) await this.vault.delete(name).catch(() => {});
  }

  // 公开视图：任何凭据都不出现，包括 URL 里的用户信息与查询串。
  public(agent) {
    const out = {
      id: agent.id,
      name: agent.name,
      transport: agent.transport,
      enabled: agent.enabled !== false,
      mrtr: cleanMrtr(agent.mrtr),
      createdAt: agent.createdAt || '',
      lastConnectedAt: agent.lastConnectedAt || '',
      lastEra: agent.lastEra || '',
      lastError: agent.lastError || null,
      hasCredentials: false
    };
    if (agent.transport === 'stdio') {
      out.stdio = {
        command: agent.stdio?.command || '',
        args: Array.isArray(agent.stdio?.args) ? [...agent.stdio.args] : [],
        envKeys: Array.isArray(agent.stdio?.envKeys) ? [...agent.stdio.envKeys] : []
      };
      out.hasCredentials = out.stdio.envKeys.length > 0;
    } else {
      const hasToken = !!(this.vault && this.vault.has(this.#key(agent.id, 'token')));
      const hasHeaderValue = !!(this.vault && this.vault.has(this.#key(agent.id, 'header')));
      const hasUrlCredentials = !!(this.vault && this.vault.has(this.#key(agent.id, 'url')));
      out.http = {
        url: maskAgentUrl(agent.http?.url || ''),
        allowPrivateHttp: agent.http?.allowPrivateHttp === true,
        headerName: agent.http?.headerName || '',
        hasToken,
        hasHeaderValue,
        hasUrlCredentials
      };
      out.hasToken = hasToken;
      out.hasHeaderValue = hasHeaderValue;
      out.hasUrlCredentials = hasUrlCredentials;
      out.tokenMask = hasToken ? '••••••' : '';
      out.hasCredentials = hasToken || hasHeaderValue || hasUrlCredentials;
    }
    return out;
  }

  list() { return this.agents.map(agent => this.public(agent)); }

  // 运行时凭据：只在服务端拼连接时读取，绝不进入 API 响应。
  credentialsFor(id) {
    const agent = this.#require(id);
    if (agent.transport === 'stdio') {
      const env = {};
      for (const key of agent.stdio?.envKeys || []) env[key] = this.vault?.get(this.#key(id, 'env.' + key)) || '';
      return {env};
    }
    const storedUrl = this.vault?.get(this.#key(id, 'url')) || '';
    return {
      url: storedUrl || agent.http?.url || '',
      token: this.vault?.get(this.#key(id, 'token')) || '',
      headerName: agent.http?.headerName || '',
      headerValue: this.vault?.get(this.#key(id, 'header')) || ''
    };
  }

  #validateCommon(input, {existing = null, isOwner = false} = {}) {
    const transport = input.transport ?? existing?.transport ?? 'http';
    if (!AGENT_TRANSPORTS.includes(transport)) throw new AgentConfigError('INVALID_TRANSPORT', '传输方式只支持 stdio 或 http');
    if (transport === 'stdio' && !isOwner) {
      throw new AgentConfigError('STDIO_OWNER_ONLY', 'stdio 只允许 owner：它等价于以服务器系统身份执行命令，多用户下会跨用户读文件。', 400);
    }
    const name = cleanName(input.name ?? existing?.name);
    const duplicate = this.agents.find(agent => agent.id !== existing?.id && agent.name.toLowerCase() === name.toLowerCase());
    if (duplicate) throw new AgentConfigError('DUPLICATE_NAME', '已有同名的外部 Agent：' + name);
    const record = {
      id: existing?.id || uuidv7(),
      name,
      transport,
      enabled: input.enabled === undefined ? (existing ? existing.enabled !== false : true) : input.enabled === true,
      mrtr: cleanMrtr(input.mrtr, existing?.mrtr || {sampling: true, elicitation: true}),
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastConnectedAt: existing?.lastConnectedAt || '',
      lastEra: existing?.lastEra || '',
      lastError: existing?.lastError || null
    };
    if (transport === 'stdio') {
      const command = String(input.command ?? existing?.stdio?.command ?? '').trim();
      if (!command) throw new AgentConfigError('INVALID_COMMAND', '请填写 stdio 命令');
      if (command.length > 300 || CONTROL.test(command)) throw new AgentConfigError('INVALID_COMMAND', 'stdio 命令需为 300 字以内的可打印文本');
      if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '' && resolve(String(input.cwd)) !== resolve(this.home)) {
        throw new AgentConfigError('CWD_NOT_ALLOWED', 'stdio 的工作目录固定为该用户目录，不能指向别处');
      }
      record.stdio = {
        command,
        args: cleanArgs(input.args ?? existing?.stdio?.args),
        envKeys: Array.isArray(existing?.stdio?.envKeys) ? [...existing.stdio.envKeys] : []
      };
      record.http = null;
    } else {
      const rawUrl = input.url ?? existing?.http?.url ?? '';
      const parsed = splitHttpUrl(rawUrl);
      const allowPrivateHttp = input.allowPrivateHttp === undefined
        ? existing?.http?.allowPrivateHttp === true
        : input.allowPrivateHttp === true;
      let sanitized;
      try { sanitized = validateEndpoint(parsed.bare, {allowPrivateHttp}); }
      catch (error) { throw new AgentConfigError('INVALID_URL', error.message); }
      const headerName = cleanHeaderName(input.headerName ?? existing?.http?.headerName);
      if (typeof input.headerValue === 'string' && input.headerValue.trim() && !headerName) {
        throw new AgentConfigError('INVALID_HEADER', '填写自定义 header 值时要同时填写 header 名');
      }
      record.http = {url: sanitized, allowPrivateHttp, headerName};
      record.stdio = null;
    }
    return record;
  }

  async create(input = {}, {isOwner = false} = {}) {
    return this.#queue(async () => {
      if (this.agents.length >= MAX_AGENTS) {
        throw new AgentConfigError('AGENT_LIMIT', '每个用户最多 10 个外部 Agent', 400);
      }
      const record = this.#validateCommon(input, {isOwner});
      if (record.transport === 'stdio') {
        const env = cleanEnv(input.env);
        record.stdio.envKeys = Object.keys(env);
        if (this.vault) for (const [key, value] of Object.entries(env)) await this.vault.set(this.#key(record.id, 'env.' + key), value);
      }
      await this.#writeHttpSecrets(record, input);
      this.agents.push(record);
      await this.#save();
      return this.public(record);
    });
  }

  async #writeHttpSecrets(record, input, existing = null) {
    if (!this.vault || record.transport !== 'http') return;
    // URL 只在本次真的提交了新地址时改写；改名字/开关不能误删 URL 里的凭据。
    // 界面拿到的是脱敏地址，原样回存脱敏地址时必须保留 vault 里的完整 URL。
    if (input.url !== undefined) {
      const parsed = splitHttpUrl(input.url);
      const unchanged = existing && !!existing.http?.url && maskAgentUrl(input.url) === maskAgentUrl(existing.http.url);
      if (parsed.hasUserInfo || parsed.hasQuery) await this.vault.set(this.#key(record.id, 'url'), parsed.raw);
      else if (!unchanged) await this.vault.delete(this.#key(record.id, 'url'));
    }
    if (typeof input.token === 'string' && input.token.trim()) await this.vault.set(this.#key(record.id, 'token'), input.token.trim());
    else if (input.clearToken === true) await this.vault.delete(this.#key(record.id, 'token'));
    const oldHeader = existing?.http?.headerName || '';
    if (!record.http.headerName || input.clearHeader === true || (input.headerName !== undefined && String(input.headerName).trim() !== oldHeader)) {
      await this.vault.delete(this.#key(record.id, 'header'));
    }
    if (record.http.headerName && typeof input.headerValue === 'string' && input.headerValue.trim()) {
      await this.vault.set(this.#key(record.id, 'header'), input.headerValue.trim());
    }
  }

  async update(id, input = {}, {isOwner = false} = {}) {
    return this.#queue(async () => {
      const existing = this.#require(id);
      const record = this.#validateCommon(input, {existing, isOwner});
      if (record.transport === 'stdio') {
        // 环境变量按 key 合并：本次没提交的 key 保留原值，显式 removeEnv 才删。
        const keys = new Set(existing.stdio?.envKeys || []);
        if (input.env !== undefined) {
          const env = cleanEnv(input.env);
          record.stdio.envKeys = [...new Set([...keys, ...Object.keys(env)])];
          if (this.vault) for (const [key, value] of Object.entries(env)) await this.vault.set(this.#key(id, 'env.' + key), value);
        } else {
          record.stdio.envKeys = [...keys];
        }
        const remove = new Set((Array.isArray(input.removeEnv) ? input.removeEnv : []).map(String));
        if (remove.size) {
          for (const key of remove) {
            record.stdio.envKeys = record.stdio.envKeys.filter(item => item !== key);
            if (this.vault) await this.vault.delete(this.#key(id, 'env.' + key));
          }
        }
        if (this.vault) for (const suffix of ['url', 'token', 'header']) await this.vault.delete(this.#key(id, suffix));
      } else {
        const oldOrigin = existing.http?.url ? new URL(existing.http.url).origin : '';
        const newOrigin = new URL(record.http.url).origin;
        if (oldOrigin && oldOrigin !== newOrigin && this.vault) {
          await this.vault.delete(this.#key(id, 'token'));
          await this.vault.delete(this.#key(id, 'url'));
        }
        await this.#writeHttpSecrets(record, input, existing);
        if (existing.transport === 'stdio' && this.vault) {
          for (const key of existing.stdio?.envKeys || []) await this.vault.delete(this.#key(id, 'env.' + key));
        }
      }
      Object.assign(existing, record);
      await this.#save();
      return this.public(existing);
    });
  }

  async remove(id) {
    return this.#queue(async () => {
      const existing = this.#require(id);
      await this.#clearVault(existing.id);
      this.agents = this.agents.filter(agent => agent.id !== existing.id);
      await this.#save();
      return {ok: true, id: existing.id};
    });
  }

  // 连接结果写回配置（lastConnectedAt / lastEra / lastError），供重启后仍能解释状态。
  async markConnected(id, {era = '', at = new Date().toISOString()} = {}) {
    return this.#queue(async () => {
      const agent = this.#find(id);
      if (!agent) return;
      agent.lastConnectedAt = at;
      agent.lastEra = era || agent.lastEra || '';
      agent.lastError = null;
      await this.#save();
    });
  }

  async markError(id, error) {
    return this.#queue(async () => {
      const agent = this.#find(id);
      if (!agent) return;
      agent.lastError = error ? {code: error.code || '', message: error.message || '', recovery: error.recovery || '', at: new Date().toISOString()} : null;
      await this.#save();
    });
  }

  // 名字冲突检查以外的辅助：给连接层判断私有 HTTP 语义。
  isPrivate(agent) {
    try { return isPrivateHostname(new URL(agent.http?.url || '').hostname); } catch { return false; }
  }
}
