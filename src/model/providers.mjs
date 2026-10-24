// 模型供应商目录：预设、地址规范化、代理与内网判断。
// 目标：让"填错地址/协议/模型名"这一类最常见的问题在保存时就暴露，
// 而不是等到对话时报一句笼统的"连接失败"。

export const PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'chat',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '国内直连可用，支持工具调用。deepseek-chat 快，deepseek-reasoner 推理强但更慢。'
  },
  zhipu: {
    label: '智谱 GLM（有免费档）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'chat',
    model: 'glm-4-flash',
    keyUrl: 'https://bigmodel.cn/console',
    note: 'glm-4-flash 免费额度适合课程演示；结构化输出较稳。'
  },
  moonshot: {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'chat',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console',
    note: '长文本友好，适合读公告原文。'
  },
  qwen: {
    label: '阿里云百炼 · 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'chat',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: 'OpenAI 兼容模式；新用户有免费额度。'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'chat',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '聚合多种开源模型，便宜，可切换 Qwen/DeepSeek 等。'
  },
  volc: {
    label: '火山方舟 · 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'chat',
    model: '',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '模型名要填"推理接入点 ID"（ep- 开头），不是展示名。'
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内直连通常不通，需要代理或中转网关。'
  },
  anthropic: {
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'messages',
    model: 'claude-3-5-sonnet-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '使用 Messages 协议；国内同样需要代理。'
  },
  openrouter: {
    label: 'OpenRouter（聚合/中转）',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'chat',
    model: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 Key 走多家模型，适合做备用链路。'
  },
  gemini: {
    label: 'Google Gemini（兼容层）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'chat',
    model: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '有免费额度；国内直连不稳定。'
  },
  ollama: {
    label: '本机 Ollama（离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
    note: '不需要 Key、不联网；7B 级模型工具调用与 JSON 稳定性一般，适合兜底演示。'
  },
  lmstudio: {
    label: '本机 LM Studio（离线）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    protocol: 'chat',
    model: 'local-model',
    keyUrl: 'https://lmstudio.ai/',
    note: '在 LM Studio 里启动 Local Server 后使用。'
  },
  gateway: {
    label: '自建网关（One API / New API / LiteLLM）',
    baseUrl: 'https://your-gateway.example.com/v1',
    protocol: 'chat',
    model: '',
    keyUrl: '',
    note: '小组共用一把 Key、按量计费、随时换模型的最佳做法；地址改成你自己的网关域名。'
  },
  custom: {
    label: '自定义接口',
    baseUrl: '',
    protocol: 'chat',
    model: '',
    keyUrl: '',
    note: '任何 OpenAI / Anthropic 兼容接口。'
  }
};

const SUFFIX = {
  chat: ['/chat/completions'],
  responses: ['/responses'],
  messages: ['/messages']
};

export function isPrivateHostname(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / CGNAT
    return false;
  }
  return false;
}

// 去掉粘贴时常见的尾部路径与空白，避免 /v1/chat/completions/chat/completions
export function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('请填写接口地址');
  s = s.replace(/\s+/g, '');
  let u;
  try { u = new URL(s); } catch { throw new Error('接口地址不是合法 URL（要带 http:// 或 https://）'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('接口地址只支持 http 或 https');
  if (u.username || u.password) throw new Error('接口地址里不要带账号密码，请填到 API Key 一栏');
  if (u.search || u.hash) throw new Error('接口地址不要带 ? 参数或 # 片段');
  let path = u.pathname.replace(/\/+$/, '');
  for (const suffixes of Object.values(SUFFIX)) for (const sx of suffixes) if (path.endsWith(sx)) path = path.slice(0, -sx.length);
  path = path.replace(/\/+$/, '');
  u.pathname = path;
  return u.origin + (path || '');
}

export function endpointFor(baseUrl, protocol) {
  const suffix = SUFFIX[protocol]?.[0];
  if (!suffix) throw new Error('未知接口协议：' + protocol);
  const base = normalizeBaseUrl(baseUrl);
  return base.endsWith(suffix) ? base : base + suffix;
}

export function detectPreset(baseUrl, protocol) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  for (const [id, p] of Object.entries(PRESETS)) {
    if (id === 'custom') continue;
    if (p.baseUrl && b && normalizeBaseUrl(p.baseUrl) === normalizeBaseUrl(b) && p.protocol === protocol) return id;
  }
  return 'custom';
}

export function presetOptions() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, protocol: p.protocol, model: p.model, keyUrl: p.keyUrl, note: p.note }));
}

export function validateProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('代理地址不是合法 URL，例如 http://127.0.0.1:7890'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('代理目前只支持 http:// 或 https://');
  if (!u.hostname) throw new Error('代理地址缺少主机名');
  if (u.pathname && u.pathname !== '/') throw new Error('代理地址不要带路径');
  return u.origin;
}

export function proxyFromEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';
  try { return validateProxy(raw); } catch { return ''; }
}

// 常见故障 → 人话。诊断和运行时共用，避免两套口径。
export function explainError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.cause?.code || error?.code || '');
  const all = message + ' ' + code;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) return { stage: 'dns', text: '域名解析失败。检查地址拼写、DNS 或是否需要代理。' };
  if (/ECONNREFUSED/i.test(all)) return { stage: 'tcp', text: '端口拒绝连接。服务没启动、地址端口写错，或被本机防火墙拦截。' };
  if (/ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|timeout|timed out|aborted/i.test(all)) return { stage: 'network', text: '连接超时。网络不通、需要代理，或模型响应太慢。' };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(all)) return { stage: 'tls', text: 'HTTPS 证书校验失败。自建服务请使用受信任证书，或改用本机 HTTP。' };
  if (/proxy|tunnel|CONNECT/i.test(all)) return { stage: 'proxy', text: '代理连接失败。检查代理地址、端口和是否需要账号。' };
  if (/401|403|unauthor|api.?key|invalid.?token/i.test(all)) return { stage: 'auth', text: '鉴权失败。API Key 填错、过期，或没有该模型的权限。' };
  if (/404|not.?found|model.?not/i.test(all)) return { stage: 'route', text: '接口或模型不存在。多半是协议选错（chat/responses/messages）或模型名写错。' };
  if (/429|quota|rate.?limit|余额|insufficient/i.test(all)) return { stage: 'quota', text: '额度不足或频率受限。等一会再试，或换备用接口。' };
  if (/JSON|Unexpected token|结构化/i.test(all)) return { stage: 'format', text: '模型没有按 JSON 返回。换更强的模型，或降低单次输出长度。' };
  return { stage: 'unknown', text: message || '未知错误' };
}

// 聊天失败时给出下一步动作，而不是只报 HTTP 状态码。
export function decorateChatError(message, hasKey) {
  const text = String(message || '');
  if (!hasKey && /鉴权失败|HTTP 401|unauthor|Authentication Fails/i.test(text)) {
    return '还没有配置 API Key，所以服务端拒绝了请求。请点左下角「模型与接口设置」，选一个供应商并粘贴 Key，点「一键体检」确认通过后再保存。原始错误：' + text;
  }
  if (!hasKey && /接口或模型不存在|HTTP 404/.test(text)) {
    return '接口或模型名不对。请打开「模型与接口设置」，按供应商预设重新选一次，并确认模型名与账号里的名称一致。原始错误：' + text;
  }
  return text;
}
