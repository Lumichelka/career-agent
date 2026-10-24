// 三层记忆：会话（session.memory）、长期画像（profile.json）、任务记录（tasks.json）。
// 规则：画像只存用户确认过的事实；任务记录自动写入，用于追溯。
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export const MEMORY_LAYERS = [
  {
    id: 'session',
    name: '会话记忆',
    scope: '当前对话',
    stores: '本轮确认的临时事实',
    rule: '每轮由模型更新，对话结束即止，不跨会话',
    writable: false
  },
  {
    id: 'profile',
    name: '长期画像',
    scope: '跨对话',
    stores: '届别、专业、城市偏好、技能标签、经历要点',
    rule: '只有用户确认后才写入；面板可查看、可删除',
    writable: true
  },
  {
    id: 'task',
    name: '任务记忆',
    scope: '单次任务',
    stores: '计划、工具调用与证据、生成的文件',
    rule: '自动记录，可追溯，用于复核与排错',
    writable: false
  }
];

export const LIMITS = {facts: 50, keyLength: 40, valueLength: 500, tasks: 100};
const memoryDir = dir => join(dir, 'memory');
const profileFile = dir => join(memoryDir(dir), 'profile.json');
const tasksFile = dir => join(memoryDir(dir), 'tasks.json');

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), {recursive: true});
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw new Error(field + ' 必须是文字');
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(field + ' 不能为空');
  if (text.length > max) throw new Error(field + ' 不能超过 ' + max + ' 个字');
  return text;
}

export async function loadProfile(dir) {
  const data = await readJson(profileFile(dir), {version: 1, facts: []});
  return {version: 1, facts: Array.isArray(data.facts) ? data.facts : []};
}

export async function saveProfile(dir, profile) {
  await writeJson(profileFile(dir), {version: 1, facts: profile.facts.slice(0, LIMITS.facts)});
  return profile;
}

export async function addFact(dir, {key, value, source = ''}) {
  const k = cleanText(key, LIMITS.keyLength, '要点名称');
  const v = cleanText(value, LIMITS.valueLength, '内容');
  const s = source ? cleanText(source, 80, '来源') : '';
  const profile = await loadProfile(dir);
  const now = new Date().toISOString();
  const existing = profile.facts.find(f => f.key === k);
  if (existing) {
    existing.value = v;
    existing.source = s || existing.source;
    existing.updatedAt = now;
  } else {
    if (profile.facts.length >= LIMITS.facts) throw new Error('画像最多保存 ' + LIMITS.facts + ' 条，请先删除旧条目');
    profile.facts.push({id: randomUUID(), key: k, value: v, source: s, createdAt: now, updatedAt: now});
  }
  await saveProfile(dir, profile);
  return profile.facts;
}

export async function deleteFact(dir, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的条目');
  const profile = await loadProfile(dir);
  const next = profile.facts.filter(f => f.id !== id);
  profile.facts = next;
  await saveProfile(dir, profile);
  return profile.facts;
}

export async function clearProfile(dir) {
  await saveProfile(dir, {version: 1, facts: []});
  return [];
}

// 把一次会话的 memory 存成一条画像（用户点击确认后调用）
export async function importSessionMemory(dir, {sessionMemory, sessionId = ''}) {
  const text = cleanText(sessionMemory || '', LIMITS.valueLength, '会话记忆');
  const today = new Date().toISOString().slice(0, 10);
  return addFact(dir, {key: '会话要点 ' + today, value: text, source: sessionId ? '会话 ' + sessionId.slice(0, 8) : '本次对话'});
}

export async function loadTasks(dir) {
  const data = await readJson(tasksFile(dir), {version: 1, tasks: []});
  return {version: 1, tasks: Array.isArray(data.tasks) ? data.tasks : []};
}

export async function recordTask(dir, task) {
  const data = await loadTasks(dir);
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    sessionId: String(task.sessionId || ''),
    title: String(task.title || '').slice(0, 60),
    status: task.status === 'failed' ? 'failed' : 'complete',
    steps: Array.isArray(task.steps) ? task.steps.slice(0, 5).map(s => String(s).slice(0, 80)) : [],
    tools: Array.isArray(task.tools) ? [...new Set(task.tools)].slice(0, 12) : [],
    artifact: task.artifact ? String(task.artifact).slice(0, 80) : '',
    durationMs: Number(task.durationMs) || 0,
    error: task.error ? String(task.error).slice(0, 160) : ''
  };
  data.tasks.unshift(entry);
  data.tasks = data.tasks.slice(0, LIMITS.tasks);
  await writeJson(tasksFile(dir), data);
  return entry;
}

export async function clearTasks(dir) {
  await writeJson(tasksFile(dir), {version: 1, tasks: []});
}

export async function memorySummary(dir) {
  const [profile, tasks] = await Promise.all([loadProfile(dir), loadTasks(dir)]);
  return {
    layers: MEMORY_LAYERS,
    counts: {profile: profile.facts.length, tasks: tasks.tasks.length},
    limits: LIMITS,
    note: '长期画像只在用户确认后写入；任务记录自动保存最近 ' + LIMITS.tasks + ' 条。'
  };
}

export async function buildMemoryPayload(dir, session = null) {
  const [profile, tasks] = await Promise.all([loadProfile(dir), loadTasks(dir)]);
  return {
    profile: profile.facts,
    tasks: tasks.tasks.slice(0, 20),
    session: session ? {id: session.id, memory: String(session.memory || '')} : null,
    layers: MEMORY_LAYERS,
    limits: LIMITS
  };
}
