// 来源 playbook：每源一份可评审的 Markdown + YAML front matter，写入口、允许域、
// 成功标志、禁止动作与抽取提示。playbook 是「源知识」，不是秘密提示词，也不做安全边界
// （安全边界见 ADR 0001：单用户本机、手动触发、可见窗口、每次确认；兜底定位见 ADR 0003）。
// 本模块只读文件、解析 front matter、把入口转成 operator 步骤；不启动浏览器、不写库。
import {readdir, readFile} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PLAYBOOK_DIR = fileURLToPath(new URL('./playbooks/', import.meta.url));

// 来源卡与任务的统一说辞：AI 兜底是手动后备，不是自动采集（ADR 0003）。
export const AI_FALLBACK_NOTE = '这是兜底，不是自动采集：只在确定性采集失败、被阻断，或你主动点击时运行。';

// Markdown 正文之前必须是 `---` 包起来的 YAML front matter。
export function splitFrontMatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return {frontMatter: '', markdown: normalized};
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return {frontMatter: '', markdown: normalized};
  const frontMatter = normalized.slice(4, end);
  const markdown = normalized.slice(end + 4).replace(/^\n/, '');
  return {frontMatter, markdown};
}

function unquote(value) {
  const raw = String(value ?? '').trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function inlineValue(value) {
  const raw = String(value ?? '').trim();
  if (/^\[.*\]$/.test(raw)) {
    return raw.slice(1, -1).split(',').map(item => unquote(item)).filter(Boolean);
  }
  return unquote(raw);
}

// 故意只支持本仓库 playbook 用到的那一小撮 YAML：`key: 值`、`key: [a, b]`、`key:` + `- 列表项`。
// 不引第三方 YAML 依赖，也不假装支持锚点/多行块；遇到不认识的写法就忽略，不让它悄悄变成空配置。
export function parseFrontMatter(source) {
  const data = {};
  let currentKey = '';
  for (const line of String(source ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item) {
      if (!currentKey) continue;
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      const value = unquote(item[1]);
      if (value) data[currentKey].push(value);
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!pair) continue;
    currentKey = pair[1];
    const value = pair[2].trim();
    data[currentKey] = value ? inlineValue(value) : [];
  }
  return data;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  const single = String(value ?? '').trim();
  return single ? [single] : [];
}

export function parsePlaybook(text, {file = ''} = {}) {
  const {frontMatter, markdown} = splitFrontMatter(text);
  const data = parseFrontMatter(frontMatter);
  const id = String(data.id ?? '').trim();
  if (!id) throw new Error('playbook 缺少 id：' + (file || '(未命名)'));
  const sourceIds = stringList(data.sourceIds);
  return {
    id,
    title: String(data.title ?? id).trim() || id,
    version: String(data.version ?? '').trim(),
    updatedAt: String(data.updatedAt ?? '').trim(),
    sourceIds: sourceIds.length ? sourceIds : [id],
    aliases: stringList(data.aliases),
    entry: stringList(data.entry),
    domains: stringList(data.domains),
    successMarkers: stringList(data.successMarkers),
    // 可选：详情页入口选择器。源卡片上的「AI 兜底」据此在列表页打开一场详情，
    // 截图才能覆盖「列表 + 详情」，与 source-check 固定两页的口径对齐。
    detailSelector: String(data.detailSelector ?? '').trim(),
    forbiddenActions: stringList(data.forbiddenActions),
    extractHints: stringList(data.extractHints),
    file: file ? basename(file) : '',
    markdown
  };
}

// 公众号账号的来源 id 是 `wechat:<账号 id>`，但只有一份 wechat playbook。
export function playbookKey(idOrSourceId) {
  const raw = String(idOrSourceId ?? '').trim();
  if (!raw) return '';
  return raw.startsWith('wechat:') ? 'wechat' : raw;
}

let cache = null;

async function readPlaybooks() {
  // README.md 说明 front matter 字段，不是 playbook。
  const names = (await readdir(PLAYBOOK_DIR)).filter(name => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort();
  return Promise.all(names.map(async name => parsePlaybook(await readFile(join(PLAYBOOK_DIR, name), 'utf8'), {file: name})));
}

export async function listPlaybooks() {
  if (!cache) {
    cache = readPlaybooks().catch(error => {
      cache = null; // 读取失败不要留下被拒绝的缓存
      throw error;
    });
  }
  return cache;
}

export async function loadPlaybook(idOrSourceId) {
  const key = playbookKey(idOrSourceId);
  if (!key) return null;
  const playbooks = await listPlaybooks();
  return playbooks.find(pb => pb.id === key || pb.sourceIds.includes(key) || pb.aliases.includes(key)) || null;
}

export async function playbookForSource(sourceId) {
  return loadPlaybook(sourceId);
}

export function playbookMatchesSource(playbook, sourceId) {
  if (!playbook) return false;
  const key = playbookKey(sourceId);
  if (!key) return false;
  return playbook.id === key || playbook.sourceIds.includes(key) || playbook.aliases.includes(key);
}

// 入口 → operator 步骤：先按顺序打开每个入口，有详情选择器就点开第一场详情，
// 最后补一张带标签的关键截图。只生成固定动作，不在这里注入任意 Playwright/JS。
export function playbookSteps(playbook) {
  const steps = [];
  for (const url of (playbook?.entry || [])) steps.push({action: 'goto', url, label: 'playbook 入口'});
  const detailSelector = String(playbook?.detailSelector || '').trim();
  if (detailSelector) steps.push({action: 'click', target: detailSelector, label: '打开详情页', text: '查看详情'});
  steps.push({action: 'screenshot', label: String(playbook?.title || 'playbook 关键截图')});
  return steps;
}
