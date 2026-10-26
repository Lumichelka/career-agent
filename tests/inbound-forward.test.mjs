import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const root = fileURLToPath(new URL('..', import.meta.url));
// 上游凭据只交给连接层；任何响应、状态、证据文件都不能出现它。
const UPSTREAM_SECRET = 'sk-upstream-secret-never-leak';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 假连接：只在进程内记录 connect / listTools / callTool，绝不联网、不启动外部进程。
function fakeAgentFactory(options = {}) {
  const state = {
    tools: options.tools || [
      {name: 'echo', title: '回声', description: '把文本带回来', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {q: {type: 'string'}}}},
      {name: 'save_note', title: '写笔记', description: '上游写入', annotations: {readOnlyHint: false}, inputSchema: {type: 'object', properties: {text: {type: 'string'}}}}
    ],
    calls: [],
    block: null,
    callError: null,
    connectError: null
  };
  const factory = async context => {
    assert.equal(context.credentials?.token, UPSTREAM_SECRET, '连接层拿到该 Agent 自己的凭据，不经过入站响应');
    if (state.connectError) throw state.connectError;
    return {
      pid: null,
      era: () => 'modern',
      serverInfo: () => ({name: 'fake-forward', version: '2.0.0'}),
      connect: async () => {},
      listTools: async () => ({tools: state.tools.map(tool => ({...tool}))}),
      callTool: async (name, args) => {
        state.calls.push({name, args: {...(args || {})}});
        if (state.block) await state.block;
        if (state.callError) throw state.callError;
        return {content: [{type: 'text', text: '上游：' + name}]};
      },
      close: async () => {}
    };
  };
  factory.state = state;
  return factory;
}

async function startApp(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-inbound-forward-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, ...options});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  const set = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean);
  return set.map(value => value.split(';')[0]).join('; ');
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST', headers: headers(app, ''),
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  const body = await response.json();
  assert.equal(response.status, 200, name + ' 注册失败：' + JSON.stringify(body));
  return {user: body.user, cookie: cookieOf(response)};
}

function web(app, cookie, path, body) {
  return fetch(app.origin + '/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: headers(app, cookie),
    ...(body ? {body: JSON.stringify(body)} : {})
  });
}

async function connect(app, token, t) {
  const client = new Client({name: 'inbound-forward-test', version: '1.0.0'}, {versionNegotiation: {mode: 'auto'}});
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.origin + '/mcp'), {
    authProvider: {token: async () => token}
  }));
  return client;
}

function parseResult(result) {
  assert.equal(result.content?.[0]?.type, 'text', '结果应是 text 块');
  return JSON.parse(result.content[0].text);
}

// 一个开启了入站、配置了一个外部 Agent、并签发了凭据的账号。
async function setup(t, {appOptions = {}, agentName = 'Dify 助手', factory = fakeAgentFactory()} = {}) {
  const app = await startApp(t, {...appOptions, agentClientFactory: factory});
  const user = await register(app, 'forward-user');
  const opened = await web(app, user.cookie, 'mcp/switch', {enabled: true, confirm: true});
  assert.equal(opened.status, 200);
  const createdResponse = await web(app, user.cookie, 'agents', {
    name: agentName, transport: 'http', url: 'https://dify.example.com/mcp', token: UPSTREAM_SECRET
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200, '创建外部 Agent 失败：' + JSON.stringify(created));
  const agent = created.agent;
  const issuedResponse = await web(app, user.cookie, 'mcp/clients', {name: 'claude-code'});
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json();
  const client = await connect(app, issued.token, t);
  return {app, user, agent, factory, issued, client};
}

test('入站 ListTools：本地工具在前，上游按 Agent 名追加并带 mcp__<agent>__<tool> 命名', async t => {
  const {app, client} = await setup(t);
  const {tools} = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('company_list'), '本地只读工具仍在');
  assert.ok(names.includes('career_recruit_bulk_write'), '本地写工具必须暴露（#29 的入站写过滤已移除）');
  assert.ok(names.includes('career_profile_write'), '本地敏感写工具也要暴露，靠确认拦');
  assert.ok(names.includes('mcp__dify__echo'), '上游工具带 Agent 命名空间：' + names.join(','));
  assert.ok(names.includes('mcp__dify__save_note'));
  assert.ok(!names.some(name => name.startsWith('career_platform_')), '任务内平台工具不进站');

  const firstUpstream = names.findIndex(name => name.startsWith('mcp__'));
  assert.ok(firstUpstream > 0);
  assert.ok(names.slice(0, firstUpstream).every(name => !name.startsWith('mcp__')), '本地工具在前');
  assert.ok(names.slice(0, firstUpstream).includes('company_list'));

  const echo = tools.find(tool => tool.name === 'mcp__dify__echo');
  assert.equal(echo.annotations?.readOnlyHint, true, '上游 readOnlyHint 透传');
  const save = tools.find(tool => tool.name === 'mcp__dify__save_note');
  assert.equal(save.annotations?.readOnlyHint, false, '缺省/显式写按写暴露');
  const localWrite = tools.find(tool => tool.name === 'career_profile_write');
  assert.equal(localWrite.annotations?.readOnlyHint, false);
});

test('转发调用：落到 #35 连接，信封标 forwarded_client + client id，上游 token 不进响应/证据', async t => {
  const {app, user, factory, issued, client} = await setup(t);
  const result = await client.callTool({name: 'mcp__dify__echo', arguments: {q: '你好'}});
  assert.equal(result.isError, false);
  const envelope = parseResult(result);
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.data.text, '上游：echo');
  assert.equal(envelope.evidence.actorType, 'forwarded_client');
  assert.equal(envelope.evidence.actorRef, issued.client.id);
  assert.equal(envelope.evidence.clientId, issued.client.id);
  assert.equal(envelope.evidence.clientName, 'claude-code');
  assert.equal(factory.state.calls.length, 1);
  assert.deepEqual(factory.state.calls[0], {name: 'echo', args: {q: '你好'}});

  assert.ok(!JSON.stringify(envelope).includes(UPSTREAM_SECRET), '响应不得回传上游 token');
  const status = await (await web(app, user.cookie, 'mcp')).json();
  assert.ok(!JSON.stringify(status).includes(UPSTREAM_SECRET), '状态不得回传上游 token');
  assert.equal(status.clients[0].lastUsedAt !== '', true, '转发调用更新最近使用');

  // 完整响应留在该用户自己的 inbound/evidence 下，且不含凭据。
  const evidenceDir = join(app.dataDir, 'users', user.user.id, 'inbound', 'evidence');
  const files = await readdir(evidenceDir);
  assert.ok(files.length >= 1, '转发调用应写证据文件');
  for (const file of files) {
    const text = await readFile(join(evidenceDir, file), 'utf8');
    assert.ok(!text.includes(UPSTREAM_SECRET), '证据文件不得包含上游 token：' + file);
    assert.equal(JSON.parse(text).actorType, 'forwarded_client', '证据能认出是转发来源');
    assert.equal(JSON.parse(text).actorRef, issued.client.id);
  }
});

test('转发本地敏感写：返回 confirm_required 且 client 不能自行执行，接受后审计标 forwarded_client', async t => {
  const {app, user, issued, client} = await setup(t);
  const facts = [{key: '城市偏好', value: '成都'}];
  const args = {facts, idempotencyKey: 'inbound-profile-1'};

  const pendingResult = await client.callTool({name: 'career_profile_write', arguments: args});
  assert.equal(pendingResult.isError, false, '待确认不是错误');
  const pending = parseResult(pendingResult);
  assert.equal(pending.status, 'confirm_required');
  assert.equal(pending.code, 'NEEDS_CONFIRMATION');
  assert.match(pending.confirmId, /^[0-9a-f-]{36}$/);

  // 网页端能看到这条没有任务卡的待确认，并知道是哪个 client 发起的。
  const listed = await (await web(app, user.cookie, 'confirmations?state=pending')).json();
  const item = listed.confirmations.find(confirmation => confirmation.confirmId === pending.confirmId);
  assert.ok(item, '待确认可由登录用户列出');
  assert.equal(item.actorType, 'forwarded_client');
  assert.equal(item.actorRef, issued.client.id);
  assert.equal(item.taskId, '');
  assert.ok(!JSON.stringify(item.preview).includes('13800138000'));

  // 客户端把 confirmId 填回来也执行不了：确认仍是 pending，也只重放同一条确认。
  const forced = parseResult(await client.callTool({name: 'career_profile_write', arguments: {...args, confirmId: pending.confirmId}}));
  assert.equal(forced.status, 'confirm_required');
  assert.equal(forced.confirmId, pending.confirmId);

  // 只有网页端接受接口能把它落库；审计保留 forwarded_client + client id。
  const acceptedResponse = await web(app, user.cookie, 'confirmations/accept', {confirmId: pending.confirmId});
  const accepted = await acceptedResponse.json();
  assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.status, 'applied');
  const audit = await (await web(app, user.cookie, 'audit')).json();
  const batch = audit.batches.find(entry => entry.tool === 'career_profile_write');
  assert.ok(batch, '审计里应有这次写入');
  assert.equal(batch.actorType, 'forwarded_client');
  assert.equal(batch.actorRef, issued.client.id);
  assert.equal(batch.rows.every(row => row.confirmed === true), true);
});

test('上游扩权：旧凭据继续可用，ListTools 立刻含新工具，状态只给提示', async t => {
  const {app, user, factory, issued, client} = await setup(t);
  const before = await (await web(app, user.cookie, 'mcp')).json();
  assert.equal(before.clients[0].newToolCount, 0);

  factory.state.tools.push({name: 'new_tool', title: '新工具', description: '签发后才出现', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {}}});

  const status = await (await web(app, user.cookie, 'mcp')).json();
  const view = status.clients[0];
  assert.equal(view.revoked, false, '不自动撤销');
  assert.equal(view.newToolCount, 1);
  assert.deepEqual(view.newTools, ['mcp__dify__new_tool']);
  assert.equal(status.clients.length, 1, '不自动重新签发');
  assert.equal(view.id, issued.client.id);

  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'mcp__dify__new_tool'), '同一凭据能看到新工具');
  const called = await client.callTool({name: 'mcp__dify__new_tool', arguments: {}});
  assert.equal(parseResult(called).status, 'ok', '新工具立即可调用');
});

test('上游错误映射为 #35 错误码与恢复建议，且不泄露上游 token', async t => {
  const {app, user, factory, client} = await setup(t);
  factory.state.callError = Object.assign(new Error('401 invalid token'), {status: 401});
  const result = await client.callTool({name: 'mcp__dify__echo', arguments: {}});
  assert.equal(result.isError, true);
  const envelope = parseResult(result);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.error.code, 'AUTH_FAILED');
  assert.ok(envelope.error.recovery, '错误必须带恢复建议');
  assert.equal(envelope.evidence.actorType, 'forwarded_client');
  assert.ok(!JSON.stringify(envelope).includes(UPSTREAM_SECRET));
  const status = await (await web(app, user.cookie, 'mcp')).json();
  assert.ok(!JSON.stringify(status).includes(UPSTREAM_SECRET));
});

test('上游连接失败映射为 #35 错误码，而不是笼统的未知工具', async t => {
  const factory = fakeAgentFactory();
  factory.state.connectError = new Error('connect ECONNREFUSED 127.0.0.1:9');
  const {client} = await setup(t, {factory});
  const envelope = parseResult(await client.callTool({name: 'mcp__dify__echo', arguments: {}}));
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.error.code, 'CONNECT_FAILED');
  assert.ok(envelope.error.recovery, '连接失败也要带恢复建议');
  assert.equal(envelope.evidence.actorType, 'forwarded_client');
  assert.ok(!JSON.stringify(envelope).includes(UPSTREAM_SECRET));
});

test('入站转发调用计入该用户在途额度：超出并发排队超时返回 QUEUE_TIMEOUT', async t => {
  const {app, factory, client} = await setup(t, {appOptions: {upstreamLimits: {perUser: 1, global: 8, queueTimeoutMs: 120}}});
  let unblock = () => {};
  factory.state.block = new Promise(resolve => { unblock = resolve; });
  const first = client.callTool({name: 'mcp__dify__echo', arguments: {q: 'first'}});
  for (let i = 0; i < 100 && factory.state.calls.length === 0; i += 1) await wait(10);
  assert.equal(factory.state.calls.length, 1, '第一个转发调用已占用在途额度');

  const second = parseResult(await client.callTool({name: 'mcp__dify__echo', arguments: {q: 'second'}}));
  assert.equal(second.status, 'error');
  assert.equal(second.error.code, 'QUEUE_TIMEOUT');
  assert.ok(second.error.recovery);

  unblock();
  const done = parseResult(await first);
  assert.equal(done.status, 'ok');
  assert.equal(factory.state.calls.length, 1, '排队超时的调用没有发给上游');
});
