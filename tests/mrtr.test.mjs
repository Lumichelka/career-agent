import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  createElicitationChannel, createMrtrHandlers, SAMPLING_SYSTEM, SAMPLING_MAX_TOKENS,
  ELICITATION_TIMEOUT_MS, ROOT_NAME
} from '../src/mcp/mrtr.mjs';
import {UpstreamGate} from '../src/mcp/gate.mjs';

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, {snapshot = {mode: 'api', protocol: 'chat', baseUrl: 'https://api.example.com/v1', model: 'deepseek-flash', apiKey: 'sk-test'}, agentMrtr = {sampling: true, elicitation: true}, events = []} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-mrtr-'));
  const home = join(dir, 'users', 'u1');
  const models = {
    snapshot: () => ({...snapshot}),
    public: () => ({...snapshot, hasKey: true})
  };
  const agent = {id: 'a1', name: 'Dify 助手', transport: 'http', enabled: true, mrtr: {...agentMrtr}};
  const handlerFactory = options => createMrtrHandlers({
    userId: 'u1',
    user: {id: 'u1', name: 'alice'},
    home,
    models,
    activeCallFor: () => ({taskId: 'task-1', emit: event => events.push(event), signal: null}),
    ...options
  });
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, home, models, agent, handlerFactory, events};
}

function recordingFetch(requests) {
  return async (url, init) => {
    requests.push({url: String(url), body: JSON.parse(init.body)});
    return new Response(JSON.stringify({
      choices: [{message: {role: 'assistant', content: '替我补全的答案'}}],
      usage: {prompt_tokens: 5, completion_tokens: 3, total_tokens: 8}
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

test('sampling：用当前模型补全，固定 system 约束、maxTokens=min(请求,2048)、不带 tools', async t => {
  const requests = [];
  const {agent, handlerFactory, events} = await setup(t);
  const handlers = handlerFactory({fetchImpl: recordingFetch(requests)}).handlersFor(agent);
  const result = await handlers.sampling({params: {
    messages: [{role: 'user', content: {type: 'text', text: '请写一句话'}}],
    maxTokens: 99999,
    systemPrompt: '这是上游自己的 system，不能覆盖固定约束',
    temperature: 1
  }});
  assert.equal(requests.length, 1, '只调用一次当前模型');
  const body = requests[0].body;
  assert.equal(body.model, 'deepseek-flash', '用该用户当前配置的模型');
  assert.equal(body.max_tokens, SAMPLING_MAX_TOKENS);
  assert.equal(body.tools, undefined, '采样不为上游声明工具');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, SAMPLING_SYSTEM);
  assert.match(requests[0].url, /\/chat\/completions$/);
  assert.deepEqual(result, {model: 'deepseek-flash', stopReason: 'endTurn', role: 'assistant', content: {type: 'text', text: '替我补全的答案'}});
  assert.equal(events.filter(event => event.type === 'mrtr_sampling_notice').length, 1, '第一次采样提示可能产生费用');
});

test('sampling：同一 Agent 只提示一次费用；请求 maxTokens 更小就取更小', async t => {
  const requests = [];
  const {agent, handlerFactory, events} = await setup(t);
  const handlers = handlerFactory({fetchImpl: recordingFetch(requests)}).handlersFor(agent);
  await handlers.sampling({params: {messages: [{role: 'user', content: 'one'}], maxTokens: 100}});
  await handlers.sampling({params: {messages: [{role: 'user', content: 'two'}], maxTokens: 100}});
  assert.equal(requests[1].body.max_tokens, 100);
  assert.equal(events.filter(event => event.type === 'mrtr_sampling_notice').length, 1);
});

test('sampling：开关关闭返回 UNSUPPORTED；带 tools 返回 UNSUPPORTED；未配置模型返回 SAMPLING_UNAVAILABLE', async t => {
  const requests = [];
  const disabled = await setup(t, {agentMrtr: {sampling: false, elicitation: true}});
  await assert.rejects(
    disabled.handlerFactory({fetchImpl: recordingFetch(requests)}).handlersFor(disabled.agent)
      .sampling({params: {messages: [{role: 'user', content: 'hi'}]}}),
    error => error.code === 'UNSUPPORTED'
  );

  const withTools = await setup(t);
  await assert.rejects(
    withTools.handlerFactory({fetchImpl: recordingFetch(requests)}).handlersFor(withTools.agent)
      .sampling({params: {messages: [{role: 'user', content: 'hi'}], tools: [{name: 'x'}]}}),
    error => error.code === 'UNSUPPORTED'
  );

  const noModel = await setup(t, {snapshot: {mode: 'api', protocol: 'chat', baseUrl: 'https://api.example.com/v1', model: ''}});
  await assert.rejects(
    noModel.handlerFactory({fetchImpl: recordingFetch(requests)}).handlersFor(noModel.agent)
      .sampling({params: {messages: [{role: 'user', content: 'hi'}]}}),
    error => error.code === 'SAMPLING_UNAVAILABLE' && /配置/.test(error.recovery || '')
  );
  assert.equal(requests.length, 0, '被拒绝的采样绝不发请求');
});

test('sampling：计入统一上游闸，额度满时排队超时返回 QUEUE_TIMEOUT', async t => {
  const gate = new UpstreamGate({perUser: 1, global: 8, queueTimeoutMs: 1000});
  const held = await gate.acquire('u1');
  const requests = [];
  const {agent, handlerFactory} = await setup(t);
  const handlers = handlerFactory({fetchImpl: recordingFetch(requests), gate, samplingTimeoutMs: 25}).handlersFor(agent);
  await assert.rejects(
    handlers.sampling({params: {messages: [{role: 'user', content: 'hi'}]}}),
    error => error.code === 'QUEUE_TIMEOUT'
  );
  held();
  await handlers.sampling({params: {messages: [{role: 'user', content: 'hi'}]}});
  assert.equal(requests.length, 1, '额度释放后正常补全');
});

test('elicitation：接受/拒绝映射为 MCP action；开关关闭 UNSUPPORTED；没有对话页就 decline', async t => {
  const {agent, handlerFactory, events} = await setup(t);
  const accepted = handlerFactory({askElicitation: async payload => ({action: 'accept', content: {school: '西南财经大学'}})}).handlersFor(agent);
  const ok = await accepted.elicitation({params: {message: '请补充学校', requestedSchema: {type: 'object', properties: {school: {type: 'string'}}}}});
  assert.deepEqual(ok, {action: 'accept', content: {school: '西南财经大学'}});

  const declined = handlerFactory({askElicitation: async () => ({action: 'decline'})}).handlersFor(agent);
  assert.deepEqual(await declined.elicitation({params: {message: 'm'}}), {action: 'decline'});

  const none = createMrtrHandlers({userId: 'u1', user: {name: 'alice'}, home: 'C:/tmp/u1', models: {snapshot: () => ({}), public: () => ({})}});
  assert.deepEqual(await none.handlersFor({...agent, mrtr: {sampling: true, elicitation: true}}).elicitation({params: {message: 'm'}}), {action: 'decline'});

  const off = await setup(t, {agentMrtr: {sampling: true, elicitation: false}});
  await assert.rejects(
    off.handlerFactory({askElicitation: async () => ({action: 'accept'})}).handlersFor(off.agent).elicitation({params: {message: 'm'}}),
    error => error.code === 'UNSUPPORTED'
  );
  assert.equal(events.length, 0);
});

test('elicitation 通道：弹表单不预填、可提交、可拒绝、5 分钟超时按 cancel 收尾', async t => {
  const events = [];
  const channel = createElicitationChannel({timeoutMs: 5000});
  const asked = channel.request({
    userId: 'u1', taskId: 'task-1', agentId: 'a1', agentName: 'Dify 助手', message: '请补充学校',
    requestedSchema: {type: 'object', properties: {school: {type: 'string'}}},
    emit: event => events.push(event)
  });
  await tick();
  const required = events.find(event => event.type === 'mrtr_elicit_required');
  assert.ok(required);
  assert.equal(required.title, '来自 Dify 助手 的请求');
  assert.equal(required.requestedSchema.properties.school.type, 'string');
  assert.equal(required.content, undefined, '绝不给表单预填用户数据');
  assert.equal(channel.respond({userId: 'u2', elicitId: asked.elicitId, action: 'accept', content: {}}), null, '别的用户处理不了');
  const accepted = channel.respond({userId: 'u1', elicitId: asked.elicitId, action: 'accept', content: {school: '西南财经大学'}});
  assert.deepEqual(accepted, {ok: true, action: 'accept'});
  assert.deepEqual(await asked.promise, {action: 'accept', content: {school: '西南财经大学'}});
  assert.ok(events.some(event => event.type === 'mrtr_elicit_resolved' && event.action === 'accept'));

  const rejected = channel.request({userId: 'u1', agentId: 'a1', agentName: 'A', emit: () => {}});
  channel.respond({userId: 'u1', elicitId: rejected.elicitId, action: 'decline'});
  assert.deepEqual(await rejected.promise, {action: 'decline'});

  const timed = createElicitationChannel({timeoutMs: 15});
  const timeoutEvents = [];
  const expired = timed.request({userId: 'u1', agentId: 'a1', agentName: 'A', emit: event => timeoutEvents.push(event)});
  assert.deepEqual(await expired.promise, {action: 'cancel'});
  assert.ok(timeoutEvents.some(event => event.type === 'mrtr_elicit_resolved' && event.reason === 'timeout'));
});

test('roots：只返回该用户自己的 users/<id>，名称「职向数据目录」', async t => {
  const {home, agent, handlerFactory} = await setup(t);
  const roots = handlerFactory().handlersFor(agent).roots();
  assert.equal(roots.roots.length, 1);
  assert.equal(roots.roots[0].name, ROOT_NAME);
  assert.equal(roots.roots[0].uri, pathToFileURL(home).href);
  assert.match(decodeURIComponent(roots.roots[0].uri), /users[\\/]u1$/);
  assert.equal(JSON.stringify(roots).includes('users/u2'), false);
});

test('超时常量：sampling 30 秒、elicitation 5 分钟、token 上限 2048', () => {
  assert.equal(SAMPLING_MAX_TOKENS, 2048);
  assert.equal(ELICITATION_TIMEOUT_MS, 300000);
});
