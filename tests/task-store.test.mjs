import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore, canTransition, publicTask, taskTiming} from '../src/server/task-store.mjs';

// Windows 上写盘与删除会抢同一目录：先 flush，再带重试地删。
async function cleanup(dir) {
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
}

async function withStore(fn, options) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-task-store-'));
  const store = await new TaskStore(dir, options).load();
  try {
    return await fn(store, dir);
  } finally {
    await store.flush().catch(() => {});
    await cleanup(dir);
  }
}

test('状态机：queued → running → succeeded，终态不能再变', async () => {
  await withStore(async store => {
    const task = store.create({sessionId: 's1', title: '测试任务', backend: 'API · mock'});
    assert.equal(task.state, 'queued');
    store.transition(task, 'running');
    assert.ok(task.startedAt, '开始运行应记录 startedAt');
    store.transition(task, 'succeeded');
    assert.ok(task.finishedAt, '终态应记录 finishedAt');
    assert.equal(canTransition('succeeded', 'running'), false);
    assert.equal(canTransition('running', 'blocked'), true);
    assert.equal(canTransition('blocked', 'running'), true);
    assert.throws(() => store.transition(task, 'running'), /任务状态不能/);
  });
});

test('事件：序号递增，progress 单调不减，证据与草稿落到任务卡', async () => {
  await withStore(async store => {
    const task = store.create({sessionId: 's1', title: '测试任务'});
    store.transition(task, 'running');
    store.record(task, {type: 'progress', percent: 30, text: '正在读取'});
    store.record(task, {type: 'progress', percent: 12, text: '倒退的进度'});
    assert.equal(task.progress.percent, 30, '进度不能倒退');
    store.record(task, {type: 'evidence', evidence: {kind: 'page', name: '就业网页面', bytes: 2048}});
    store.record(task, {type: 'draft', draft: {title: '文稿', chars: 42, artifactId: 'a1'}});
    const seqs = task.events.map(event => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件序号应递增');
    assert.equal(task.evidence.length, 1);
    assert.equal(task.evidence[0].name, '就业网页面');
    assert.ok(task.evidence[0].id, '每条证据应有稳定 id');
    assert.equal(task.draft.title, '文稿');
    assert.equal(task.draft.artifactId, 'a1');
  });
});

test('错误事件写进任务卡，保留 code 与恢复建议', async () => {
  await withStore(async store => {
    const task = store.create({sessionId: 's1', title: '测试任务'});
    store.transition(task, 'running');
    store.record(task, {type: 'error', text: '连接失败', code: 'CONNECT_FAILED', recovery: '检查地址'});
    store.transition(task, 'failed');
    assert.equal(task.error.code, 'CONNECT_FAILED');
    assert.equal(task.error.message, '连接失败');
    assert.equal(task.error.recovery, '检查地址');
    assert.equal(task.state, 'failed');
  });
});

test('列表按最近创建排前面，可按对话过滤；publicTask 不带事件历史', async () => {
  await withStore(async store => {
    const first = store.create({sessionId: 's1', title: '旧任务'});
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = store.create({sessionId: 's2', title: '新任务'});
    const all = store.list();
    assert.deepEqual(all.map(task => task.id), [second.id, first.id]);
    assert.deepEqual(store.list({sessionId: 's1'}).map(task => task.id), [first.id]);
    const view = publicTask(first);
    assert.equal(view.events, undefined, '列表快照不带完整事件历史');
    assert.ok(view.eventCount >= 1);
    assert.ok(Number.isFinite(view.queuedMs) && Number.isFinite(view.durationMs));
  });
});

test('持久化：重新加载后任务、证据与草稿都在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-task-persist-'));
  try {
    const store = await new TaskStore(dir).load();
    const task = store.create({sessionId: 's1', title: '持久化任务'});
    store.transition(task, 'running');
    store.record(task, {type: 'evidence', evidence: {kind: 'screenshot', name: '截图', url: 'https://example.com/a.png'}});
    store.record(task, {type: 'draft', draft: {title: '草稿', chars: 10, artifactId: 'a1'}});
    store.transition(task, 'succeeded');
    await store.flush();

    const reloaded = await new TaskStore(dir).load();
    try {
      const found = reloaded.find(task.id);
      assert.ok(found, '任务应能从 tasks.json 读回');
      assert.equal(found.state, 'succeeded');
      assert.equal(found.evidence.length, 1);
      assert.equal(found.draft.title, '草稿');
      assert.ok(found.events.some(event => event.type === 'task_state' && event.state === 'succeeded'));
    } finally {
      await reloaded.flush().catch(() => {});
    }
  } finally {
    await cleanup(dir);
  }
});

test('重启恢复：未结束的任务标失败并记录原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-task-restart-'));
  try {
    const store = await new TaskStore(dir).load();
    const task = store.create({sessionId: 's1', title: '运行中的任务'});
    store.transition(task, 'running');
    await store.flush();

    const reloaded = await new TaskStore(dir).load();
    try {
      const found = reloaded.find(task.id);
      assert.equal(found.state, 'failed', '重启后不应留下永远运行中的任务');
      assert.equal(found.stopReason, 'restart');
      assert.equal(found.error.code, 'TASK_INTERRUPTED');
    } finally {
      await reloaded.flush().catch(() => {});
    }
  } finally {
    await cleanup(dir);
  }
});

test('事件超长时只保留最近 N 条，任务数量也有上限', async () => {
  await withStore(async store => {
    const task = store.create({sessionId: 's1', title: '长任务'});
    store.transition(task, 'running');
    for (let i = 0; i < 30; i++) store.record(task, {type: 'progress', percent: i, text: '第 ' + i + ' 步'});
    assert.equal(task.events.length, 20, '默认只保留最近 20 条事件');
    for (let i = 0; i < 5; i++) store.create({sessionId: 's1', title: '任务 ' + i});
    assert.equal(store.list().length, 5);
  }, {maxEvents: 20, maxTasks: 5});
});

test('taskTiming 用开始/结束时间算排队与运行时长', () => {
  const timing = taskTiming({createdAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:00:05.000Z', finishedAt: '2026-01-01T10:01:05.000Z'});
  assert.equal(timing.queuedMs, 5000);
  assert.equal(timing.durationMs, 60000);
});
