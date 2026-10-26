import test from 'node:test';
import assert from 'node:assert/strict';
import {UpstreamGate, UPSTREAM_LIMITS} from '../src/mcp/gate.mjs';
import {AgentConnectionManager} from '../src/mcp/client.mjs';

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function fakeAgent() {
  return {id: 'a1', name: 'Dify 助手', transport: 'http', enabled: true, mrtr: {sampling: true, elicitation: true}, http: {url: 'https://agent.example.com/mcp', allowPrivateHttp: false, headerName: ''}};
}

function fakeConfig(agent) {
  return {
    agents: [agent],
    credentialsFor: () => ({url: 'https://agent.example.com/mcp'}),
    markConnected: async () => {},
    markError: async () => {}
  };
}

function makeManager({gate, userId = 'u1', onCall = null} = {}) {
  const agent = fakeAgent();
  const calls = [];
  const manager = new AgentConnectionManager({
    home: 'C:/tmp/users/u1',
    config: fakeConfig(agent),
    gate,
    userId,
    createConnection: async () => ({
      connect: async () => {},
      era: () => 'modern',
      serverInfo: () => null,
      listTools: async () => ({tools: []}),
      callTool: async (name, args) => {
        calls.push({name, args, active: gate?.snapshot().active ?? 0});
        if (onCall) return onCall({name, args});
        return {content: [{type: 'text', text: 'ok'}]};
      },
      close: async () => {}
    })
  });
  return {manager, calls, agent};
}

test('上游闸：每用户 2 / 全局 8 / 排队 120 秒的默认额度', () => {
  assert.deepEqual(new UpstreamGate().snapshot(), {perUser: 2, global: 8, queueTimeoutMs: 120000, active: 0, queued: 0, byUser: {}});
  assert.deepEqual(UPSTREAM_LIMITS, {perUser: 2, global: 8, queueTimeoutMs: 120000});
});

test('上游闸：同一用户第 3 个并发排队，释放一个才轮到；另一用户不受影响', async () => {
  const gate = new UpstreamGate({perUser: 2, global: 8, queueTimeoutMs: 1000});
  const release1 = await gate.acquire('u1');
  const release2 = await gate.acquire('u1');
  assert.deepEqual(gate.snapshot().byUser, {u1: 2});
  let third = null;
  const queued = gate.acquire('u1').then(release => { third = release; return release; });
  const other = await gate.acquire('u2');
  assert.equal(other instanceof Function, true, '另一用户立即拿到额度');
  await tick();
  assert.equal(third, null, '同一用户第 3 个仍在排队');
  assert.equal(gate.snapshot().queued, 1);
  release1();
  const release3 = await queued;
  assert.equal(typeof release3, 'function', '释放后第 3 个被唤醒');
  assert.deepEqual(gate.snapshot().byUser, {u1: 2, u2: 1});
  release2(); release3(); other();
  assert.deepEqual(gate.snapshot().byUser, {});
  assert.equal(gate.snapshot().active, 0);
});

test('上游闸：排队超时返回 QUEUE_TIMEOUT 且带恢复建议，不泄漏额度', async () => {
  const gate = new UpstreamGate({perUser: 1, global: 8, queueTimeoutMs: 30});
  const release = await gate.acquire('u1');
  await assert.rejects(
    gate.acquire('u1'),
    error => error.code === 'QUEUE_TIMEOUT' && /稍后重试/.test(error.recovery) && error.name === 'UpstreamQueueTimeoutError'
  );
  assert.deepEqual(gate.snapshot().byUser, {u1: 1}, '超时的 waiter 已从队列摘掉');
  release();
  const again = await gate.acquire('u1');
  again();
});

test('上游闸：取消排队立即失败，不占额度', async () => {
  const gate = new UpstreamGate({perUser: 1, global: 8, queueTimeoutMs: 1000});
  const release = await gate.acquire('u1');
  const controller = new AbortController();
  const waiting = gate.acquire('u1', {signal: controller.signal});
  controller.abort();
  await assert.rejects(waiting, error => error.code === 'CANCELLED');
  assert.equal(gate.snapshot().queued, 0);
  release();
});

test('闸与出站共用：模型调用占满额度时，MCP 出站调用排队，释放后完成', async () => {
  const gate = new UpstreamGate({perUser: 2, global: 8, queueTimeoutMs: 1000});
  // 两个「模型 API 调用」占满该用户额度（模拟流式调用还没结束）。
  const releaseModel1 = await gate.acquire('u1');
  const releaseModel2 = await gate.acquire('u1');
  const {manager, calls} = makeManager({gate, userId: 'u1'});
  let completed = false;
  const outbound = manager.callTool('a1', 'search', {q: 'x'}).then(value => { completed = true; return value; });
  await tick();
  assert.equal(completed, false, '模型调用占满额度时出站调用在排队');
  assert.equal(calls.length, 0, '排队期间没有真的发出上游调用');
  releaseModel1();
  const value = await outbound;
  assert.equal(value.content[0].text, 'ok');
  assert.equal(calls.length, 1);
  releaseModel2();
  assert.equal(gate.snapshot().active, 0);
});

test('另一用户的出站调用不受本用户额度影响', async () => {
  const gate = new UpstreamGate({perUser: 1, global: 8, queueTimeoutMs: 1000});
  const release = await gate.acquire('u1');
  const one = makeManager({gate, userId: 'u1'});
  const two = makeManager({gate, userId: 'u2'});
  const pending = one.manager.callTool('a1', 'search', {});
  await tick();
  assert.equal(one.calls.length, 0, 'u1 已满在排队');
  const out = await two.manager.callTool('a1', 'search', {});
  assert.equal(out.content[0].text, 'ok');
  assert.equal(two.calls.length, 1);
  release();
  await pending;
});

test('出站排队超时经连接层映射为 QUEUE_TIMEOUT，带恢复建议', async () => {
  const gate = new UpstreamGate({perUser: 1, global: 8, queueTimeoutMs: 20});
  const release = await gate.acquire('u1');
  const {manager} = makeManager({gate, userId: 'u1'});
  await assert.rejects(
    manager.callTool('a1', 'search', {}),
    error => error.code === 'QUEUE_TIMEOUT' && /排队超时|稍后重试/.test(error.recovery)
  );
  release();
});

test('出站调用持有额度：调用期间 active=1，结束释放；MRTR 能从 activeCallFor 找到当前任务', async () => {
  const gate = new UpstreamGate({perUser: 2, global: 8, queueTimeoutMs: 1000});
  let seenActive = 0;
  let seenContext = null;
  const {manager} = makeManager({gate, userId: 'u1', onCall: async () => {
    seenActive = gate.snapshot().active;
    seenContext = manager.activeCallFor('a1');
    return {content: [{type: 'text', text: 'ok'}]};
  }});
  const emit = () => {};
  const out = await manager.callTool('a1', 'search', {}, {context: {taskId: 'task-1', emit}});
  assert.equal(out.content[0].text, 'ok');
  assert.equal(seenActive, 1, '调用期间占 1 个额度');
  assert.equal(seenContext.taskId, 'task-1');
  assert.equal(manager.activeCallFor('a1'), null, '结束后清掉当前任务');
  assert.equal(gate.snapshot().active, 0);
});
