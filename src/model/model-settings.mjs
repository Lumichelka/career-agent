import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PRESETS, normalizeBaseUrl, validateProxy, isPrivateHostname} from './providers.mjs';

export const DEFAULT_MODEL = {
  preset: 'custom',
  mode: 'api',
  protocol: 'chat',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  searchUrl: '',
  proxy: '',
  allowPrivateHttp: false,
  maxTokens: 8192,
  temperature: 0.3,
  stream: true
};

export function validateEndpoint(raw, {allowPrivateHttp = false} = {}) {
  const base = normalizeBaseUrl(raw);
  const u = new URL(base);
  const local = isPrivateHostname(u.hostname);
  if (u.protocol === 'http:' && !local) throw new Error('公网地址必须使用 HTTPS；只允许本机或局域网地址用 HTTP');
  if (u.protocol === 'http:' && local && !allowPrivateHttp && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('访问局域网地址的 HTTP 接口需要勾选“允许局域网 HTTP”');
  }
  return base;
}

export function validateModelSettings(input) {
  if (!['codex', 'local', 'api'].includes(input.mode)) throw new Error('不支持的模型后端');
  if (!['chat', 'responses', 'messages'].includes(input.protocol)) throw new Error('不支持的接口协议');
  const allowPrivateHttp = input.allowPrivateHttp === true;
  const isCodex = input.mode === 'codex';
  let baseUrl = DEFAULT_MODEL.baseUrl;
  if (!isCodex || input.baseUrl) baseUrl = validateEndpoint(input.baseUrl || DEFAULT_MODEL.baseUrl, {allowPrivateHttp});
  const model = String(input.model || '').trim();
  if (!isCodex && (!model || model.length > 150)) throw new Error('请填写接口实际支持的模型名');
  const host = new URL(baseUrl).hostname;
  if (input.mode === 'local' && !isPrivateHostname(host)) throw new Error('本地模型模式只接受本机或局域网服务地址，远程接口请选择 API 模式');
  const maxTokens = Number(input.maxTokens || DEFAULT_MODEL.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 256 || maxTokens > 64000) throw new Error('单次输出上限需在 256 到 64000 之间');
  const preset = PRESETS[input.preset] ? input.preset : 'custom';
  const fallback = validateFallback(input.fallback, {allowPrivateHttp});
  return {
    preset,
    mode: input.mode,
    protocol: input.protocol,
    baseUrl,
    model,
    searchUrl: input.searchUrl ? validateEndpoint(input.searchUrl, {allowPrivateHttp}) : '',
    proxy: validateProxy(input.proxy),
    allowPrivateHttp,
    maxTokens,
    temperature: Number.isFinite(Number(input.temperature)) ? Math.min(1.5, Math.max(0, Number(input.temperature))) : DEFAULT_MODEL.temperature,
    stream: input.stream !== false,
    ...(fallback ? {fallback} : {})
  };
}

function validateFallback(raw, opts) {
  if (!raw || raw.enabled !== true) return null;
  if (!['chat', 'responses', 'messages'].includes(raw.protocol)) throw new Error('备用接口协议无效');
  const baseUrl = validateEndpoint(raw.baseUrl, opts);
  const model = String(raw.model || '').trim();
  if (!model) throw new Error('备用接口需要填写模型名');
  return {enabled: true, preset: PRESETS[raw.preset] ? raw.preset : 'custom', protocol: raw.protocol, baseUrl, model};
}

export function backendLabel(c) {
  if (c.mode === 'codex') return '本机 Codex';
  const p = PRESETS[c.preset]?.label;
  const body = (c.mode === 'local' ? '本地模型 · ' : 'API · ') + (p && c.preset !== 'custom' ? p + ' / ' : '') + c.model;
  return c.fallback?.enabled ? body + '（含备用链路）' : body;
}

export class ModelSettings {
  constructor(root, vault = null) {
    this.file = join(root, '.data', 'model-settings.json');
    this.vault = vault;
    this.key = '';
    this.fallbackKey = '';
    this.allowEnvironmentKey = true;
    this.config = {...DEFAULT_MODEL};
  }

  async load() {
    try {
      this.config = validateModelSettings(JSON.parse(await readFile(this.file, 'utf8')));
    } catch { /* 配置损坏时退回默认值，不阻断启动 */ }
    if (this.vault) {
      this.key = this.vault.get('model.apiKey');
      this.fallbackKey = this.vault.get('fallback.apiKey');
    }
    return this;
  }

  public() {
    const env = this.allowEnvironmentKey && process.env.CAREER_MODEL_API_KEY ? '环境变量 CAREER_MODEL_API_KEY' : '';
    return {
      ...this.config,
      hasKey: !!(this.key || env),
      keySource: this.key ? '已加密保存在本机' : env || '',
      hasFallbackKey: !!this.fallbackKey,
      label: backendLabel(this.config),
      providerNote: PRESETS[this.config.preset]?.note || ''
    };
  }

  snapshot() {
    const envKey = this.allowEnvironmentKey ? process.env.CAREER_MODEL_API_KEY : '';
    return {
      ...this.config,
      apiKey: this.key || envKey || '',
      fallback: this.config.fallback ? {...this.config.fallback, apiKey: this.fallbackKey || ''} : null
    };
  }

  async save(input) {
    const next = validateModelSettings(input);
    if (this.vault) {
      const nextOrigin = new URL(next.baseUrl).origin;
      const oldOrigin = new URL(this.config.baseUrl || 'http://127.0.0.1').origin;
      if (input.clearKey) { this.key = ''; await this.vault.delete('model.apiKey'); }
      else if (input.apiKey) { this.key = String(input.apiKey).trim(); await this.vault.set('model.apiKey', this.key); }
      else if (nextOrigin !== oldOrigin) { this.key = ''; await this.vault.delete('model.apiKey'); }
      if (input.clearFallbackKey) { this.fallbackKey = ''; await this.vault.delete('fallback.apiKey'); }
      else if (input.fallback?.apiKey) { this.fallbackKey = String(input.fallback.apiKey).trim(); await this.vault.set('fallback.apiKey', this.fallbackKey); }
      else if (!next.fallback) { this.fallbackKey = ''; await this.vault.delete('fallback.apiKey'); }
    } else {
      if (input.apiKey) this.key = String(input.apiKey).trim();
      if (input.clearKey) this.key = '';
      if (input.fallback?.apiKey) this.fallbackKey = String(input.fallback.apiKey).trim();
      if (input.clearFallbackKey) this.fallbackKey = '';
    }
    this.config = next;
    await writeFile(this.file, JSON.stringify(next, null, 2), 'utf8');
    return this.public();
  }

  async setPreset(id) {
    const p = PRESETS[id];
    if (!p) throw new Error('未知的供应商预设');
    this.config = {...this.config, preset: id, baseUrl: p.baseUrl || this.config.baseUrl, protocol: p.protocol, model: p.model || this.config.model};
    return this.public();
  }
}
