import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startMockOpenAI} from './test-mock-openai.mjs';
import {runApiModel, parseJsonLoose, cleanJsonText} from './api-model.mjs';
import {runAgent} from './agent.mjs';
import {runDiagnostics} from './diag.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

test('流式接口能聚合成完整 JSON', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    const data = JSON.parse(out.raw);
    assert.match(data.reply, /测试回复/);
  } finally { await mock.close(); }
});

test('非流式接口同样可用', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 2048};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.ok(out.raw.length > 10);
  } finally { await mock.close(); }
});

test('工具调用后继续对话并留下证据', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const out = await runApiModel({root, prompt: '请调用 career_platform_status 检查连接状态', search: true, config});
    assert.equal(out.toolEvidence.length, 1);
    assert.match(out.toolEvidence[0], /career_platform_status/);
    assert.match(out.trace[0].label, /career_platform_status/);
    assert.ok(JSON.parse(out.raw).reply);
  } finally { await mock.close(); }
});

test('429 会自动退避重试', async () => {
  const mock = await startMockOpenAI();
  try {
    mock.state.failNext = 1;
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.ok(out.raw.includes('测试回复'));
    assert.equal(mock.state.requests.length >= 2, true);
  } finally { await mock.close(); }
});

test('JSON 修复：代码围栏、尾逗号、前后废话', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1,}\n```'), {a: 1});
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":2} 以上。'), {a: 2});
  assert.equal(cleanJsonText('```json\n{"a":1}\n```'), '{"a":1}');
});

test('完整执行链路：规划 → 执行 → 复核', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const result = await runAgent({
      root,
      session: {messages: [], memory: '', artifacts: []},
      message: '帮我看看这个岗位',
      modelCall: options => runApiModel({...options, config})
    });
    assert.equal(result.plan.steps.length, 2);
    assert.match(result.reply, /测试回复/);
    assert.equal(result.sources.length, 1);
    assert.ok(result.durationMs >= 0);
  } finally { await mock.close(); }
});

test('接口体检：全链路通过时报告 ok', async () => {
  const mock = await startMockOpenAI();
  try {
    const report = await runDiagnostics({protocol: 'chat', baseUrl: mock.url, model: 'mock-model', apiKey: ''});
    assert.equal(report.ok, true);
    const ids = report.stages.map(s => s.id);
    assert.deepEqual(ids, ['env', 'endpoint', 'dns', 'tcp', 'http', 'tools', 'json']);
    assert.equal(report.stages.find(s => s.id === 'http').status, 'pass');
  } finally { await mock.close(); }
});

test('接口体检：鉴权失败能定位到 http 阶段', async () => {
  const mock = await startMockOpenAI();
  try {
    mock.state.status = 401;
    const report = await runDiagnostics({protocol: 'chat', baseUrl: mock.url, model: 'x', apiKey: 'bad'});
    assert.equal(report.ok, false);
    const http = report.stages.find(s => s.id === 'http');
    assert.equal(http.status, 'fail');
    assert.match(http.fix, /鉴权/);
  } finally { await mock.close(); }
});
