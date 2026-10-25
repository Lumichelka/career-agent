// 模型后端注册与每轮能力解析：codex / local / api（agent 先占位，#34 接入配置）。
// 规则：图片附件 → vision；否则 text + tools；外部 Agent 永不作为视觉候选。
// 任何换后端都由用户点一次，不做静默降级。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {PRESETS, isPrivateHostname} from './providers.mjs';
import {estimateCallCost, formatCny} from './prices.mjs';

export const BACKEND_CHOICES = ['api', 'local', 'codex'];
export const BACKEND_KINDS = ['api', 'local', 'codex', 'agent'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 5;
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

// 已知视觉型号（按研究里的一手型号表）。未列出的型号按纯文本处理：宁可不出候选，也不把图发给读不了的模型。
const VISION_MODEL = {
  deepseek: /^deepseek-(flash|v4-flash)/i,
  zhipu: /(glm-(4\.6v|4v|5v|4\.5v)|glm-5\.3-flash)/i,
  moonshot: /^kimi-k3/i,
  qwen: /(qwen3\.8|qwen3\.7-plus|qwen3-vl|vl)/i,
  siliconflow: /(vl|vision|glm-4\.5v|glm-5\.3-flash)/i,
  openai: /(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/i,
  anthropic: /claude/i,
  gemini: /gemini/i,
  openrouter: /(gpt-4o|claude|gemini|vl|vision)/i,
  ollama: /(vl|vision)/i,
  lmstudio: /(vl|vision)/i,
  custom: /(vl|vision)/i
};

export function visionModel({preset, model} = {}) {
  const pattern = VISION_MODEL[String(preset || '')] || VISION_MODEL.custom;
  return pattern.test(String(model || ''));
}

export function modelCapabilities({preset, model} = {}) {
  const capabilities = ['text', 'tools'];
  if (visionModel({preset, model})) capabilities.push('vision');
  return capabilities;
}

// 本轮能力：附件里有图片才要 vision；其余默认 text + tools。
export function turnCapabilities(attachments = []) {
  const capabilities = ['text', 'tools'];
  if ((Array.isArray(attachments) ? attachments : []).some(isImageAttachment)) capabilities.push('vision');
  return capabilities;
}

export function isImageAttachment(attachment) {
  if (!attachment || attachment.type !== 'image') return false;
  if (!IMAGE_MIME.test(String(attachment.mime || ''))) return false;
  const raw = attachment.dataUrl ?? attachment.data ?? attachment.base64;
  return typeof raw === 'string' && raw.length > 0;
}

function base64Bytes(base64) {
  return Math.floor(String(base64).replace(/\s+/g, '').length * 3 / 4);
}

// 统一成 data URL；只接受图片 MIME，超过 8MB 的单图直接拒绝。
export function normalizeImageAttachment(attachment) {
  if (!isImageAttachment(attachment)) return null;
  const mime = String(attachment.mime).toLowerCase().replace('image/jpg', 'image/jpeg');
  let dataUrl = String(attachment.dataUrl ?? attachment.data ?? attachment.base64 ?? '');
  if (!/^data:/i.test(dataUrl)) dataUrl = 'data:' + mime + ';base64,' + dataUrl.replace(/\s+/g, '');
  if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(dataUrl)) return null;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = base64Bytes(base64);
  if (!bytes || bytes > MAX_IMAGE_BYTES) return null;
  return {name: String(attachment.name || '图片'), type: 'image', mime, dataUrl, bytes};
}

// 一次请求最多 5 张、总量 ≤8MB；大小按 base64 估算，不落盘。
export function validateImages(attachments = []) {
  const images = [];
  let totalBytes = 0;
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!isImageAttachment(attachment)) continue;
    const image = normalizeImageAttachment(attachment);
    if (!image) return {images: [], totalBytes: 0, error: '图片无法读取或单张超过 8MB'};
    images.push(image);
    totalBytes += image.bytes;
  }
  if (images.length > MAX_IMAGE_COUNT) return {images: [], totalBytes, error: '一次最多 5 张图片'};
  if (totalBytes > MAX_IMAGE_TOTAL_BYTES) return {images: [], totalBytes, error: '图片总量超过 8MB，请压缩或减少图片后重试'};
  return {images, totalBytes, error: ''};
}

// 请求体形状由 api-model 负责；这里按协议给出图片段，日志与证据永不使用 dataUrl。
export function imageContentFor(protocol, images = []) {
  const list = (Array.isArray(images) ? images : []).filter(image => image && typeof image.dataUrl === 'string');
  if (!list.length) return null;
  if (protocol === 'messages') return list.map(image => ({
    type: 'image',
    source: {type: 'base64', media_type: image.mime || 'image/png', data: image.dataUrl.replace(/^data:[^;]+;base64,/, '')}
  }));
  if (protocol === 'responses') return list.map(image => ({type: 'input_image', image_url: image.dataUrl}));
  return list.map(image => ({type: 'image_url', image_url: {url: image.dataUrl}}));
}

// 每用户「上次选择」：API 侧与 Agent 侧分开存，本票只写 API 侧（api/local/codex）。
export class BackendChoice {
  constructor(dir) {
    if (!dir) throw new Error('BackendChoice 需要用户数据目录');
    this.file = join(dir, 'backend-choice.json');
    this.state = {api: '', agent: ''};
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (BACKEND_CHOICES.includes(raw?.api)) this.state.api = raw.api;
      if (typeof raw?.agent === 'string') this.state.agent = raw.agent;
    } catch { /* 没有选择或文件损坏：沿用设置里的模式 */ }
    return this;
  }

  snapshot() {
    return {...this.state};
  }

  current(settings = {}) {
    if (BACKEND_CHOICES.includes(this.state.api)) return this.state.api;
    return BACKEND_CHOICES.includes(settings?.mode) ? settings.mode : 'api';
  }

  async set(kind) {
    if (!BACKEND_CHOICES.includes(kind)) throw new Error('未知的后端');
    this.state = {...this.state, api: kind};
    await mkdir(dirname(this.file), {recursive: true});
    await writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    return this.snapshot();
  }
}

function endpointKind(settings) {
  if (settings?.mode === 'local') return 'local';
  if (settings?.mode === 'api') return 'api';
  try {
    return isPrivateHostname(new URL(settings.baseUrl).hostname) ? 'local' : 'api';
  } catch {
    return 'api';
  }
}

function backendLabelFor(kind, settings = {}) {
  if (kind === 'codex') return '本机 Codex';
  const preset = PRESETS[settings.preset]?.label;
  const prefix = kind === 'local' ? '本地模型 · ' : 'API · ';
  return prefix + (preset && settings.preset !== 'custom' ? preset + ' / ' : '') + (settings.model || '待配置');
}

function endpointEntry(settings = {}) {
  const model = String(settings.model || '').trim();
  if (!model || !settings.baseUrl) return null;
  let host = '';
  try { host = new URL(settings.baseUrl).hostname; } catch { return null; }
  if (settings.hasKey !== true && !isPrivateHostname(host)) return null; // 没 Key 的公网接口不算已配置
  const kind = endpointKind(settings);
  const capabilities = modelCapabilities({preset: settings.preset, model});
  const cost = estimateCallCost({preset: settings.preset, model, capabilities});
  return {
    kind,
    label: backendLabelFor(kind, settings),
    capabilities,
    preset: settings.preset || 'custom',
    model,
    configured: true,
    approxCostPerCall: cost,
    approxCostLabel: formatCny(cost),
    configTarget: 'model-settings',
    note: ''
  };
}

function unconfiguredEntry(kind) {
  const recommended = kind === 'api'
    ? {preset: 'deepseek', model: 'deepseek-flash', label: '模型 API · 待配置（推荐 DeepSeek Flash）'}
    : {preset: 'ollama', model: 'qwen3-vl:8b', label: '本地模型 · 待配置（推荐 qwen3-vl）'};
  const capabilities = ['text', 'tools', 'vision'];
  const cost = estimateCallCost({preset: recommended.preset, model: recommended.model, capabilities});
  return {
    kind,
    label: recommended.label,
    capabilities,
    preset: recommended.preset,
    model: recommended.model,
    configured: false,
    approxCostPerCall: cost,
    approxCostLabel: formatCny(cost),
    configTarget: 'model-settings',
    note: '点击去「模型与接口设置」配置'
  };
}

// 注册表：codex 占一个槽（owner 才可用），一个已配置的 API/本地接口占一个槽，另一个槽给配置入口。
export function backendEntries({settings = {}, user = null} = {}) {
  const isOwner = user?.name === 'owner';
  const entries = [{
    kind: 'codex',
    label: '本机 Codex',
    capabilities: ['text', 'tools'],
    preset: 'codex',
    model: '',
    configured: isOwner,
    approxCostPerCall: null,
    approxCostLabel: '',
    configTarget: isOwner ? '' : 'owner-only',
    note: isOwner ? '使用本机 Codex 登录；没有 usage 时记「订阅额度」' : '只有 owner 能使用本机 Codex'
  }];
  const endpoint = endpointEntry(settings);
  if (endpoint) entries.push(endpoint);
  for (const kind of ['api', 'local']) {
    if (endpoint && endpoint.kind === kind) continue;
    entries.push(unconfiguredEntry(kind));
  }
  entries.push({
    kind: 'agent',
    label: '外部 Agent',
    capabilities: ['text', 'tools'], // 永不 vision
    preset: '',
    model: '',
    configured: false,
    approxCostPerCall: null,
    approxCostLabel: '',
    configTarget: 'agent-settings',
    note: '外部 Agent 的配置与连接在 #34 接入'
  });
  return entries;
}

function toCard(entry) {
  return {
    kind: entry.kind,
    label: entry.label,
    capabilities: [...(entry.capabilities || [])],
    approxCostPerCall: entry.approxCostPerCall ?? null,
    approxCostLabel: entry.approxCostLabel || '',
    configured: entry.configured === true,
    preset: entry.preset || '',
    model: entry.model || '',
    configTarget: entry.configTarget || '',
    note: entry.note || ''
  };
}

function toBackend(entry) {
  return {kind: entry.kind, label: entry.label, preset: entry.preset || '', model: entry.model || '', capabilities: [...entry.capabilities]};
}

function compareCards(a, b) {
  if (a.configured !== b.configured) return a.configured ? -1 : 1;
  const left = a.approxCostPerCall, right = b.approxCostPerCall;
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

// 候选 = 满足本轮能力；视觉任务永远排除 agent；已配置的排前面，同组按约每次费用升序、无价排后。
export function candidatesFor(entries = [], capabilities = ['text', 'tools']) {
  const needs = Array.isArray(capabilities) ? capabilities : [];
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => !(needs.includes('vision') && entry.kind === 'agent'))
    .filter(entry => !(entry.kind === 'codex' && entry.configured !== true)) // 非 owner 看不到本机 Codex 入口
    .filter(entry => needs.every(capability => Array.isArray(entry.capabilities) && entry.capabilities.includes(capability)))
    .map(toCard)
    .sort(compareCards);
}

function currentKindOf(settings = {}, choice = null) {
  const saved = typeof choice?.snapshot === 'function' ? choice.snapshot().api : choice?.api;
  if (BACKEND_CHOICES.includes(saved)) return saved;
  return BACKEND_CHOICES.includes(settings?.mode) ? settings.mode : 'api';
}

function cardForKind(kind, settings) {
  return {
    kind,
    label: backendLabelFor(kind, settings),
    capabilities: [],
    approxCostPerCall: null,
    approxCostLabel: '',
    configured: false,
    preset: settings?.preset || '',
    model: settings?.model || '',
    configTarget: kind === 'codex' ? 'owner-only' : 'model-settings',
    note: ''
  };
}

function candidateMessage(current, capabilities) {
  if (capabilities.includes('vision')) {
    if (current.kind === 'agent') return '外部 Agent 不读图，请选择视觉模型 API 或去掉图片后重试。';
    return '当前后端「' + (current.label || current.kind) + '」不支持本次需要的视觉能力。请选择一个候选后端；也可以去掉图片后重试。';
  }
  return '当前后端「' + (current.label || current.kind) + '」还没有配置好，请选择一个候选后端或先到「模型与接口设置」完成配置。';
}

// 本轮开始前解析：满足就返回 backend；不满足就停下列候选（不降级、不猜）。
export function resolveTurn({settings = {}, choice = null, user = null, requested = '', attachments = []} = {}) {
  const capabilities = turnCapabilities(attachments);
  const entries = backendEntries({settings, user});
  const currentKind = BACKEND_CHOICES.includes(requested) ? requested : currentKindOf(settings, choice);
  const currentEntry = entries.find(entry => entry.kind === currentKind) || null;
  const current = currentEntry ? toCard(currentEntry) : cardForKind(currentKind, settings);
  const candidates = candidatesFor(entries, capabilities);
  const satisfied = !!currentEntry && currentEntry.configured && capabilities.every(capability => currentEntry.capabilities.includes(capability));
  if (satisfied) return {ok: true, code: 'OK', capabilities, backend: toBackend(currentEntry), current, candidates};
  return {ok: false, code: 'CANDIDATE_REQUIRED', capabilities, current, candidates, message: candidateMessage(current, capabilities)};
}

// 顶栏要的视图：当前后端、能力、文本任务的候选（视觉候选在 candidate_required 事件里给）。
export function publicBackends({settings = {}, choice = null, user = null} = {}) {
  const currentKind = currentKindOf(settings, choice);
  const entries = backendEntries({settings, user});
  const currentEntry = entries.find(entry => entry.kind === currentKind) || null;
  const current = currentEntry ? toCard(currentEntry) : cardForKind(currentKind, settings);
  const snapshot = typeof choice?.snapshot === 'function' ? choice.snapshot() : (choice || {});
  return {
    current: {...current, locked: false},
    capabilities: currentEntry ? [...currentEntry.capabilities] : [],
    candidates: candidatesFor(entries, turnCapabilities([])),
    choices: {api: currentKind, agent: snapshot.agent || ''},
    kinds: [...BACKEND_CHOICES],
    setup: {configTarget: 'model-settings', agentTarget: 'agent-settings'}
  };
}

// 选择：只有已配置的后端能成为当前选择；codex 仅 owner。切换对下一轮生效。
export async function selectBackend({settings = {}, choice = null, user = null, kind} = {}) {
  if (!BACKEND_CHOICES.includes(kind)) return {ok: false, status: 400, code: 'INVALID_BACKEND', message: '未知的后端'};
  const entries = backendEntries({settings, user});
  const entry = entries.find(item => item.kind === kind && item.configured);
  if (!entry) {
    if (kind === 'codex' && user?.name !== 'owner') {
      return {ok: false, status: 403, code: 'CODEX_OWNER_ONLY', message: '只有 owner 能使用本机 Codex，请配置自己的模型 API 或本地模型。'};
    }
    return {ok: false, status: 409, code: 'BACKEND_NOT_CONFIGURED', message: '这个后端还没有配置。', configTarget: 'model-settings'};
  }
  if (choice && typeof choice.set === 'function') await choice.set(kind);
  return {
    ok: true,
    code: 'OK',
    current: toCard(entry),
    choices: {api: kind, agent: (typeof choice?.snapshot === 'function' ? choice.snapshot().agent : '') || ''}
  };
}
