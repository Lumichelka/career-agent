import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskGate, TaskManager, summarizeTasks} from '../src/server/tasks.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tempDir(t, prefix = 'zx-tasks-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('任务闸：同一用户至多 2 个任务，第 3 个 FIFO 排队；不同用户互不阻塞', async t => {
  const gate = new TaskGate({perUser: 2, global: 8});
  const releaseFirst = await gate.acquire('user-a');
  const releaseSecond = await gate.acquire('user-a');

  let third = null;
  const thirdReady = gate.acquire('user-a').then(release => { third = release; });
  await wait(20);
  assert.equal(third, null, '同一用户的第 3 个任务应排队等前面结束');
  assert.equal(gate.snapshot().queued, 1);

  const releaseOther = await gate.acquire('user-b');
  assert.equal(typeof releaseOther, 'function', '另一个用户不应被 user-a 的排队挡住');

  releaseFirst();
  await thirdReady;
  assert.equal(typeof third, 'function', '前面任务结束后应轮到排队的任务');

  releaseSecond();
  releaseOther();
  third();
});

test('任务闸：排队超过上限给出 QUEUE_TIMEOUT 与可执行的恢复建议', async t => {
  const gate = new TaskGate({perUser: 1, queueTimeoutMs: 30});
  const release = await gate.acquire('user-a');
  await assert.rejects(gate.acquire('user-a'), error => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    assert.match(error.message, /排队/);
    assert.match(error.message, /停止|稍后/);
    assert.ok(error.recovery, '应带恢复建议');
    return true;
  });
  assert.equal(gate.snapshot().queued, 0, '超时的任务要移出队列');
  release();
});

test('任务闸：全局上限 8，跨用户共享额度', async t => {
  const gate = new TaskGate({perUser: 2, global: 2});
  const releaseA = await gate.acquire('user-a');
  const releaseB = await gate.acquire('user-b');
  assert.equal(gate.snapshot().active, 2);

  let third = null;
  const thirdReady = gate.acquire('user-c').then(release => { third = release; });
  await wait(20);
  assert.equal(third, null, '全局额度满时新用户也要排队');

  releaseA();
  await thirdReady;
  assert.equal(typeof third, 'function');
  releaseB();
  third();
});

test('任务闸默认值：每用户 2、全局 8、排队 120 秒；整任务上限 15 分钟', () => {
  const gate = new TaskGate();
  assert.equal(gate.snapshot().perUser, 2);
  assert.equal(gate.snapshot().global, 8);
  assert.equal(gate.queueTimeoutMs, 120000);
  const manager = new TaskManager({dataDir: 'unused-for-defaults'});
  assert.equal(manager.maxDurationMs, 15 * 60 * 1000);
});

test('任务统计：徽标只计运行中与待确认', () => {
  const summary = summarizeTasks([
    {state: 'running'}, {state: 'waiting_confirmation'}, {state: 'queued'},
    {state: 'succeeded'}, {state: 'failed'}, {state: 'cancelled'}
  ]);
  assert.equal(summary.badge, 2, '排队、成功、失败都不进徽标');
  assert.equal(summary.counts.running, 1);
  assert.equal(summary.counts.waiting_confirmation, 1);
  assert.equal(summary.counts.total, 6);
});

test('任务闸：排队按 FIFO 顺序依次获得执行位', async t => {
  const gate = new TaskGate({perUser: 1});
  const releaseFirst = await gate.acquire('user-a');
  const order = [];
  const second = gate.acquire('user-a').then(release => { order.push('second'); return release; });
  const third = gate.acquire('user-a').then(release => { order.push('third'); return release; });
  await wait(20);
  assert.deepEqual(order, []);
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(order, ['second']);
  await wait(10);
  assert.deepEqual(order, ['second'], '前一个任务没结束前不开始下一个');
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, ['second', 'third']);
  releaseThird();
});

async function managerFor(t, options = {}) {
  const dataDir = await tempDir(t);
  return {dataDir, manager: new TaskManager({dataDir, ...options})};
}

test('任务生命周期：queued → running → succeeded，事件与持久化记录一一对应', async t => {
  const {dataDir, manager} = await managerFor(t);
  const events = [];
  const outcome = await manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '来源校对', sourceName: '西南财大',
    emit: event => events.push(event),
    execute: async ({emit, addDraft}) => {
      emit({type: 'status', text: '正在读取页面'});
      emit({type: 'plan', plan: {goal: '校对来源', steps: ['读列表', '读详情'], needsSearch: true, deliverable: '表格'}});
      emit({type: 'tool', toolType: 'web_search', text: '正在检索公开信息'});
      addDraft({title: '活动草稿', content: '待确认内容'});
      return {reply: '完成'};
    }
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.task.state, 'succeeded');
  assert.equal(outcome.result.reply, '完成');
  assert.notEqual(outcome.task.id, 'session-1', '任务 id 必须与会话 id 分离');
  assert.equal(outcome.task.sessionId, 'session-1');

  const taskEvents = events.filter(event => event.type === 'task');
  assert.deepEqual(taskEvents.map(event => event.state), ['queued', 'running', 'succeeded']);
  for (const event of taskEvents) {
    assert.equal(typeof event.taskId, 'string');
    assert.equal(typeof event.phase, 'string');
    assert.ok(event.counts && typeof event.counts === 'object', '任务事件要有稳定 counts');
  }
  assert.ok(events.some(event => event.type === 'progress' && event.phase === '正在读取页面'), '状态阶段要能推进到任务卡');
  assert.ok(events.some(event => event.type === 'evidence' && event.evidence.label === '正在检索公开信息'), '工具调用要留下证据');
  assert.equal(outcome.task.counts.tools, 1);
  assert.equal(outcome.task.counts.steps, 2);
  assert.equal(outcome.task.counts.evidence, 1);
  assert.equal(outcome.task.counts.drafts, 1);
  assert.equal(outcome.task.drafts[0].title, '活动草稿');
  assert.equal(outcome.task.drafts[0].status, 'draft');

  const summary = await manager.summary('user-a');
  assert.equal(summary.tasks.length, 1);
  assert.equal(summary.tasks[0].id, outcome.task.id);
  assert.equal(summary.tasks[0].userId, undefined, 'HTTP 记录不暴露内部用户 id');
  assert.equal(summary.badge, 0, '成功任务不进顶栏徽标');

  const reloaded = new TaskManager({dataDir});
  const persisted = await reloaded.summary('user-a');
  assert.equal(persisted.tasks[0].state, 'succeeded', '抽屉刷新要能重新读到任务记录');
  assert.equal(persisted.tasks[0].sourceName, '西南财大');
});

test('任务生命周期：执行失败进入 failed，错误码与恢复建议写入记录和事件', async t => {
  const {manager} = await managerFor(t);
  const events = [];
  const outcome = await manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '失败任务', sourceName: '对话',
    emit: event => events.push(event),
    execute: async () => {
      const error = new Error('模型连接失败');
      error.code = 'CONNECT_FAILED';
      error.recovery = '检查接口地址后重试';
      throw error;
    }
  });

  assert.equal(outcome.task.state, 'failed');
  assert.equal(outcome.error.code, 'CONNECT_FAILED');
  assert.equal(outcome.task.error.code, 'CONNECT_FAILED');
  assert.match(outcome.task.error.message, /连接失败/);
  const errorEvent = events.find(event => event.type === 'error');
  assert.ok(errorEvent, '失败要发出 error 事件');
  assert.equal(errorEvent.code, 'CONNECT_FAILED');
  assert.equal(errorEvent.taskId, outcome.task.id);
  const lastTask = events.filter(event => event.type === 'task').at(-1);
  assert.equal(lastTask.state, 'failed');
  assert.equal(lastTask.error.code, 'CONNECT_FAILED');
  assert.equal(lastTask.counts.tools, 0);

  const summary = await manager.summary('user-a');
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.badge, 0);
});

test('任务生命周期：到整任务上限就停止，并把原因写进记录', async t => {
  const {manager} = await managerFor(t, {maxDurationMs: 80});
  const events = [];
  const outcome = await manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '长任务', sourceName: '对话',
    emit: event => events.push(event),
    execute: async ({signal}) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        const stop = () => { clearTimeout(timer); reject(new Error('本次任务已停止。')); };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, {once: true});
      });
      return {reply: '不应到这里'};
    }
  });

  assert.equal(outcome.task.state, 'failed');
  assert.equal(outcome.task.error.code, 'TASK_TIMEOUT');
  assert.match(outcome.task.error.message, /上限/);
  assert.ok(events.some(event => event.type === 'error' && event.code === 'TASK_TIMEOUT'), '超时要给前端明确错误');
  assert.equal(events.filter(event => event.type === 'task').at(-1).state, 'failed');
});

test('任务生命周期：停止运行中的任务进入 cancelled，并以停止原因收尾', async t => {
  const {manager} = await managerFor(t);
  const events = [];
  let taskId = '';
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const running = manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '可停止任务', sourceName: '对话',
    emit: event => {
      events.push(event);
      if (event.type === 'task') {
        taskId = event.taskId;
        if (event.state === 'running') startedResolve();
      }
    },
    execute: async ({signal}) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        const stop = () => { clearTimeout(timer); reject(new Error('本次任务已停止。')); };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, {once: true});
      });
      return {reply: '不应到这里'};
    }
  });
  await started;

  const stopped = await manager.stop('user-a', taskId);
  assert.equal(stopped.ok, true, '本人可以停止自己的任务');
  const outcome = await running;
  assert.equal(outcome.task.state, 'cancelled');
  assert.match(outcome.error.message, /停止/);

  const summary = await manager.summary('user-a');
  assert.equal(summary.tasks[0].state, 'cancelled');
  assert.equal(summary.badge, 0);
});

test('任务生命周期：跨用户不能停止或查看别人的任务', async t => {
  const {manager} = await managerFor(t);
  const running = manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '他人任务', sourceName: '对话',
    emit: () => {},
    execute: async ({signal}) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        const stop = () => { clearTimeout(timer); reject(new Error('本次任务已停止。')); };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, {once: true});
      });
    }
  });
  let aliceTasks = await manager.summary('user-a');
  for (let i = 0; i < 300 && !aliceTasks.tasks.length; i++) {
    await wait(10);
    aliceTasks = await manager.summary('user-a');
  }
  assert.equal(aliceTasks.tasks.length, 1, '任务记录应已落盘');
  const taskId = aliceTasks.tasks[0].id;

  const blocked = await manager.stop('user-b', taskId);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'missing', '别人的任务在本用户视角下不存在');
  const bobTasks = await manager.summary('user-b');
  assert.equal(bobTasks.tasks.length, 0);

  await manager.stop('user-a', taskId);
  await running;
});

test('任务闸：排队超时把任务记为 failed 并给出 QUEUE_TIMEOUT', async t => {
  const dataDir = await tempDir(t);
  const manager = new TaskManager({dataDir, gate: new TaskGate({perUser: 1, queueTimeoutMs: 30})});
  const release = await manager.gate.acquire('user-a');
  const events = [];
  const outcome = await manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '排队任务', sourceName: '对话',
    emit: event => events.push(event),
    execute: async () => ({reply: '不应到这里'})
  });
  release();

  assert.equal(outcome.task.state, 'failed');
  assert.equal(outcome.task.error.code, 'QUEUE_TIMEOUT');
  assert.match(outcome.task.error.message, /排队/);
  assert.match(outcome.task.error.recovery, /稍后|停止/);
  assert.deepEqual(events.filter(event => event.type === 'task').map(event => event.state), ['queued', 'failed']);
  assert.ok(events.some(event => event.type === 'error' && event.code === 'QUEUE_TIMEOUT'));
});

test('任务卡：草稿可保存/丢弃，动作落盘且只对本人可见', async t => {
  const {manager} = await managerFor(t);
  const outcome = await manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '草稿任务', sourceName: '对话',
    execute: async ({addDraft}) => {
      addDraft({title: '活动草稿', content: '活动与单位待确认'});
      return {reply: '完成'};
    }
  });
  const draftId = outcome.task.drafts[0].id;

  const saved = await manager.setDraft('user-a', {taskId: outcome.task.id, draftId, action: 'save'});
  assert.equal(saved.ok, true);
  assert.equal(saved.task.drafts[0].status, 'saved');

  const discarded = await manager.setDraft('user-a', {taskId: outcome.task.id, draftId, action: 'discard'});
  assert.equal(discarded.ok, true);
  assert.equal(discarded.task.drafts[0].status, 'discarded');

  const rejected = await manager.setDraft('user-a', {taskId: outcome.task.id, draftId, action: 'explode'});
  assert.equal(rejected.ok, false, '未知动作要拒绝');

  const otherUser = await manager.setDraft('user-b', {taskId: outcome.task.id, draftId, action: 'save'});
  assert.equal(otherUser.ok, false, '跨用户不能改别人的草稿');
});


test('operator 任务：动作时间线入任务卡，登录暂停 waiting_login，人工续跑后从停点继续', {timeout: 20000}, async t => {
  const {manager} = await managerFor(t);
  const events = [];
  const calls = [];
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  let loginSeen;
  const seen = new Promise(resolve => { loginSeen = resolve; });

  const running = manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '来源操作 · 公众号', sourceName: '来源操作',
    emit: event => {
      events.push(event);
      if (event.type === 'task' && event.state === 'waiting_login') loginSeen();
    },
    execute: async ({emit}) => {
      emit({type: 'operator_action', step: 1, total: 2, action: 'goto', target: 'https://mp.weixin.qq.com/', result: 'ok', screenshotRef: 'action-001.png', at: new Date().toISOString()});
      emit({type: 'operator_waiting', state: 'waiting_login', kind: 'login', reason: '页面需要登录，请在本窗口登录后继续。', step: 2, total: 2});
      await gate;
      calls.push('resumed');
      emit({type: 'operator_running', step: 2, total: 2});
      emit({type: 'operator_action', step: 2, total: 2, action: 'screenshot', target: '文章列表', result: 'ok', screenshotRef: 'action-002.png', at: new Date().toISOString()});
      return {ok: true};
    }
  });

  await Promise.race([seen, wait(10000).then(() => { throw new Error('没有等到 waiting_login'); })]);
  assert.deepEqual(calls, [], '暂停期间不能继续执行后续步骤');
  const pending = await manager.summary('user-a');
  assert.equal(pending.tasks[0].state, 'waiting_login');
  assert.equal(pending.badge, 1, '等待登录要计入徽标');
  assert.equal(pending.tasks[0].operator.state, 'waiting_login');
  assert.equal(pending.tasks[0].operator.actions.length, 1);
  assert.equal(pending.tasks[0].operator.actions[0].screenshotRef, 'action-001.png');
  assert.equal(pending.tasks[0].operator.waiting.kind, 'login');

  // 重新读取也要能拿到时间线（抽屉刷新不靠内存）。
  const reloaded = new TaskManager({dataDir: manager.dataDir});
  const persisted = await reloaded.summary('user-a');
  assert.equal(persisted.tasks[0].operator.actions.length, 1);

  resume();
  const outcome = await running;
  assert.deepEqual(calls, ['resumed']);
  assert.equal(outcome.task.state, 'succeeded');
  assert.equal(outcome.task.operator.state, 'succeeded');
  assert.equal(outcome.task.operator.actions.length, 2);
  assert.equal(outcome.task.operator.waiting, null);
  assert.equal((await manager.summary('user-a')).badge, 0);
});

test('任务生命周期：等待用户登录/确认时进入 waiting_confirmation，徽标计入，确认后回到成功', async t => {
  const {manager} = await managerFor(t);
  const events = [];
  let confirm;
  const waiting = new Promise(resolve => { confirm = resolve; });
  let waitingSeen;
  const seen = new Promise(resolve => { waitingSeen = resolve; });
  const running = manager.run({
    userId: 'user-a', sessionId: 'session-1', title: '等待确认任务', sourceName: '对话',
    emit: event => {
      events.push(event);
      if (event.type === 'task' && event.state === 'waiting_confirmation') waitingSeen();
    },
    execute: async ({emit}) => {
      emit({type: 'platform_required', platform: 'boss', platformName: 'BOSS直聘', reason: '需要本人登录'});
      await waiting;
      emit({type: 'platform_resolved', platform: 'boss'});
      return {reply: '登录后完成'};
    }
  });

  // 事件在落盘之后发出，所以看到事件时记录已经可读；不靠固定次数轮询，避免机器忙时误判。
  await Promise.race([seen, wait(10000).then(() => { throw new Error('没有等到 waiting_confirmation 事件'); })]);
  const pending = await manager.summary('user-a');
  assert.equal(pending.tasks[0].state, 'waiting_confirmation');
  assert.equal(pending.badge, 1, '待确认要计入徽标');
  assert.match(pending.tasks[0].phase, /等待/);

  confirm();
  const outcome = await running;
  assert.equal(outcome.task.state, 'succeeded');
  assert.ok(events.some(event => event.type === 'task' && event.state === 'waiting_confirmation'), '状态事件要能到前端');
  assert.equal((await manager.summary('user-a')).badge, 0);
});
