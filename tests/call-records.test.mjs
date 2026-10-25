import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runAgent, errorCodeOf} from '../src/agent/agent.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FINAL = {
  reply: '这是测试回复。',
  memory: '',
  artifact: {title: '', content: ''},
  sources: [{title: '示例来源', url: 'https://example.com/jobs'}],
  visualization: {title: '', unit: '', items: []}
};
const PLAN = {goal: '回答测试问题', steps: ['理解需求', '给出答复'], needsSearch: false, deliverable: '一段文字'};
const backend = {kind: 'api', preset: 'deepseek', model: 'deepseek-flash', label: 'API · DeepSeek / deepseek-flash'};

function scriptedModel({throwOn = '', usage = {input: 111, output: 22, total: 133}, model = 'deepseek-flash'} = {}) {
  return async options => {
    const stage = options.prompt.includes('规划阶段') ? 'plan' : options.prompt.includes('复核阶段') ? 'review' : 'act';
    if (stage === throwOn) throw new Error('连接超时，请检查网络');
    return {raw: JSON.stringify(stage === 'plan' ? PLAN : FINAL), usage: usage ? {...usage} : null, backend: {...backend, model}};
  };
}

test('调用记录：规划/执行/复核各一条，带后端、耗时、usage 与估算费用', async () => {
  const result = await runAgent({
    root, session: {messages: [], memory: '', artifacts: []}, message: '帮我看看这个岗位',
    backend, modelCall: scriptedModel()
  });
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.calls.map(call => call.step), ['plan', 'act', 'review']);
  for (const call of result.calls) {
    assert.deepEqual(call.backend, backend);
    assert.match(call.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(call.outcome, 'ok');
    assert.ok(call.durationMs >= 0);
    assert.deepEqual(call.usage, {input: 111, output: 22, total: 133});
    assert.equal(call.cost.estimated, true);
    assert.ok(call.cost.cny > 0);
    assert.ok(call.cost.priceVersion);
  }
  // 规划一次的费用按价表的 worked example 核对：111 输入 + 22 输出。
  const expected = ((111 * 0.15 + 22 * 0.6) / 1e6) * 7.2;
  assert.ok(Math.abs(result.calls[0].cost.cny - expected) < 1e-12);
});

test('调用记录：供应商没回 usage 时不写 usage/cost（界面显示未回传）', async () => {
  const result = await runAgent({
    root, session: {messages: [], memory: '', artifacts: []}, message: '帮我看看这个岗位',
    backend, modelCall: scriptedModel({usage: null})
  });
  for (const call of result.calls) {
    assert.equal('usage' in call, false);
    assert.equal('cost' in call, false);
  }
});

test('调用记录：价表没这个型号时只留 tokens，不给金额', async () => {
  const unknown = {kind: 'api', preset: 'moonshot', model: 'kimi-k3.1-pro', label: 'API · Kimi'};
  const result = await runAgent({
    root, session: {messages: [], memory: '', artifacts: []}, message: '帮我看看这个岗位',
    backend: unknown, modelCall: scriptedModel({usage: {input: 10, output: 2, total: 12}})
  });
  for (const call of result.calls) {
    assert.deepEqual(call.usage, {input: 10, output: 2, total: 12});
    assert.equal(call.cost, undefined, '未知价不能显示金额');
  }
});

test('调用记录：错误码按失败类型归档', () => {
  assert.equal(errorCodeOf(new Error('连接超时，请检查网络')), 'REQUEST_TIMEOUT');
  assert.equal(errorCodeOf(new Error('鉴权失败（HTTP 401）')), 'AUTH_FAILED');
  assert.equal(errorCodeOf(new Error('额度或频率受限（HTTP 429）')), 'RATE_LIMITED');
  assert.equal(errorCodeOf(new Error('连接模型服务失败')), 'CONNECT_FAILED');
  assert.equal(errorCodeOf(new Error('本次任务已停止。')), 'CANCELLED');
  assert.equal(errorCodeOf(new Error('接口或模型不存在，请检查协议与模型名')), 'MODEL_NOT_FOUND');
  assert.equal(errorCodeOf(new Error('模型没有返回内容。')), 'UPSTREAM_ERROR');
});
