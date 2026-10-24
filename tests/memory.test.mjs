import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  loadProfile, addFact, deleteFact, clearProfile, importSessionMemory,
  loadTasks, recordTask, clearTasks, memorySummary, buildMemoryPayload, LIMITS
} from '../src/agent/memory.mjs';
import {buildContext} from '../src/agent/context.mjs';
import {buildPrompt} from '../src/agent/agent.mjs';

async function tempDir() { return mkdtemp(join(tmpdir(), 'zx-memory-')); }

test('画像：添加、去空格、同 key 更新而不是重复', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual((await loadProfile(dir)).facts, []);
    let facts = await addFact(dir, {key: '  目标城市 ', value: ' 成都、上海 ', source: '用户确认'});
    assert.equal(facts.length, 1);
    assert.equal(facts[0].key, '目标城市');
    assert.equal(facts[0].value, '成都、上海');
    facts = await addFact(dir, {key: '目标城市', value: '成都'});
    assert.equal(facts.length, 1);
    assert.equal(facts[0].value, '成都');
    assert.equal(facts[0].source, '用户确认', '更新时保留旧来源');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('画像：校验名称/内容/条数上限', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => addFact(dir, {key: '', value: 'x'}), /不能为空/);
    await assert.rejects(() => addFact(dir, {key: 'x'.repeat(41), value: 'x'}), /不能超过 40/);
    await assert.rejects(() => addFact(dir, {key: 'k', value: 'x'.repeat(501)}), /不能超过 500/);
    for (let i = 0; i < LIMITS.facts; i++) await addFact(dir, {key: 'k' + i, value: 'v' + i});
    await assert.rejects(() => addFact(dir, {key: 'overflow', value: 'v'}), /最多保存/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('画像：删除、清空、会话导入', async () => {
  const dir = await tempDir();
  try {
    const facts = await addFact(dir, {key: '专业', value: '金融学'});
    await deleteFact(dir, facts[0].id);
    assert.equal((await loadProfile(dir)).facts.length, 0);
    await addFact(dir, {key: '届别', value: '2027'});
    await importSessionMemory(dir, {sessionMemory: '用户关注成都的产品实习', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890'});
    const after = await loadProfile(dir);
    assert.equal(after.facts.length, 2);
    assert.match(after.facts[1].key, /会话要点/);
    await clearProfile(dir);
    assert.equal((await loadProfile(dir)).facts.length, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('画像持久化：重新读取仍在，文件不是明文以外的结构', async () => {
  const dir = await tempDir();
  try {
    await addFact(dir, {key: '城市', value: '成都'});
    const raw = JSON.parse(await readFile(join(dir, 'memory', 'profile.json'), 'utf8'));
    assert.equal(raw.facts[0].key, '城市');
    const again = await loadProfile(dir);
    assert.equal(again.facts[0].value, '成都');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('任务记录：写入、最新在前、上限、清空', async () => {
  const dir = await tempDir();
  try {
    await recordTask(dir, {sessionId: 's1', title: '排行程', status: 'complete', steps: ['查活动', '排班'], tools: ['career_recruit_events', 'career_recruit_events'], artifact: '行程表', durationMs: 1200});
    const tasks = (await loadTasks(dir)).tasks;
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].tools, ['career_recruit_events'], '工具去重');
    await recordTask(dir, {sessionId: 's2', title: '失败任务', status: 'failed', error: '网络错误'});
    const list = (await loadTasks(dir)).tasks;
    assert.equal(list[0].sessionId, 's2', '最新在前');
    for (let i = 0; i < LIMITS.tasks + 5; i++) await recordTask(dir, {sessionId: 'x' + i, title: 't' + i});
    assert.equal((await loadTasks(dir)).tasks.length, LIMITS.tasks);
    await clearTasks(dir);
    assert.equal((await loadTasks(dir)).tasks.length, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('记忆概要：层、计数、限制', async () => {
  const dir = await tempDir();
  try {
    await addFact(dir, {key: '城市', value: '成都'});
    await recordTask(dir, {sessionId: 's', title: '任务'});
    const summary = await memorySummary(dir);
    assert.equal(summary.layers.length, 3);
    assert.equal(summary.counts.profile, 1);
    assert.equal(summary.counts.tasks, 1);
    assert.equal(summary.limits.facts, LIMITS.facts);
    const payload = await buildMemoryPayload(dir, {id: 'sid', memory: '本次要点'});
    assert.equal(payload.session.memory, '本次要点');
    assert.equal(payload.profile.length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('画像会进入上下文和提示词', async () => {
  const profile = [{key: '目标城市', value: '成都', updatedAt: '2026-10-24T00:00:00.000Z'}];
  const context = buildContext({messages: [], memory: ''}, '找实习', [], profile);
  assert.equal(context.profile[0].key, '目标城市');
  const prompt = buildPrompt({messages: [], memory: ''}, '找实习', [], profile);
  assert.ok(prompt.includes('目标城市'));
  assert.ok(prompt.includes('成都'));
});
