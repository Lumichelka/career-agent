import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 假 transport：只记录 connect / listTools / callTool，绝不启动真实外部 Agent 或联网。
function fakeFactory(options = {}) {
  const log = [];
  const factory = async context => {
    factory.calls += 1;
    const index = factory.calls;
    log.push({kind: 'context', index, token: context.credentials?.token || '', url: context.credentials?.url || '', agent: context.agent.name});
    return {
      pid: null,
      era: () => options.era || 'modern',
      serverInfo: () => ({name: 'fake-mcp', version: '2.0.0'}),
      connect: async () => {
        log.push({kind: 'connect', index});
        if (options.fail) throw options.fail;
      },
      listTools: async () => {
        log.push({kind: 'listTools', index});
        return {tools: options.tools || [
          {name: 'lookup', annotations: {readOnlyHint: true}},
          {name: 'publish'}
        ]};
      },
      callTool: async () => { log.push({kind: 'callTool', index}); return {content: []}; },
      close: async () => { log.push({kind: 'close', index}); }
    };
  };
  factory.calls = 0;
  factory.log = log;
  return factory;
}

async function startApp(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-agents-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, ...options});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}
function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}
async function login(app, name, password) {
  const response = await fetch(app.origin + '/api/auth/login', {method: 'POST', headers: headers(app, ''), body: JSON.stringify({name, password})});
  const payload = await response.json();
  assert.equal(response.status, 200, name + ' 登录失败：' + JSON.stringify(payload));
  return {user: payload.user, cookie: cookieOf(response)};
}
async function ownerLogin(app) {
  const text = await readFile(join(app.dataDir, '首次登录.txt'), 'utf8');
  return login(app, 'owner', text.match(/密码：(.+)/)?.[1]?.trim());
}
async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {method: 'POST', headers: headers(app, ''), body: JSON.stringify({name, password: 'correct-horse-battery'})});
  const payload = await response.json();
  assert.equal(response.status, 200, name + ' 注册失败：' + JSON.stringify(payload));
  return {user: payload.user, cookie: cookieOf(response)};
}
async function call(app, method, path, cookie, body) {
  const response = await fetch(app.origin + path, {
    method,
    headers: headers(app, cookie),
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const payload = await response.json();
  return {status: response.status, body: payload};
}
const post = (app, path, cookie, body) => call(app, 'POST', path, cookie, body);

const httpAgent = (overrides = {}) => ({
  name: 'Dify 助手', transport: 'http', url: 'https://dify.example.com/mcp', token: 'sk-http-secret', ...overrides
});

test('HTTP：owner 新增 HTTP Agent、测试连接只连接与发现，凭据只显掩码', async t => {
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const owner = await ownerLogin(app);

  const created = await post(app, '/api/agents', owner.cookie, httpAgent());
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.agent.id;
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(created.body.agent.hasToken, true);
  assert.doesNotMatch(JSON.stringify(created.body), /sk-http-secret/);

  const listed = await call(app, 'GET', '/api/agents', owner.cookie);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.owner, true);
  assert.deepEqual(listed.body.transports, ['stdio', 'http']);
  assert.equal(listed.body.max, 10);
  assert.equal(listed.body.agents.length, 1);
  assert.equal(listed.body.agents[0].http.url, 'https://dify.example.com/mcp');
  assert.equal(listed.body.agents[0].state, 'disconnected');
  assert.doesNotMatch(JSON.stringify(listed.body), /sk-http-secret/);

  const tested = await post(app, '/api/agents/test', owner.cookie, {id});
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
  assert.equal(tested.body.agent.state, 'connected');
  assert.equal(tested.body.agent.era, 'modern');
  assert.deepEqual(tested.body.agent.serverInfo, {name: 'fake-mcp', version: '2.0.0'});
  assert.equal(tested.body.agent.tools.length, 2);
  assert.equal(tested.body.agent.tools.find(tool => tool.name === 'lookup').readOnly, true);
  assert.equal(tested.body.agent.tools.find(tool => tool.name === 'publish').readOnly, false);
  assert.ok(tested.body.agent.lastConnectedAt);
  const connectedKinds = factory.log.filter(item => item.kind !== 'context').map(item => item.kind);
  assert.deepEqual(connectedKinds, ['connect', 'listTools'], '测试连接不能调用工具');
  assert.equal(factory.log.find(item => item.kind === 'context').token, 'sk-http-secret', '运行期从 KeyVault 取凭据');

  const status = await call(app, 'GET', '/api/agents', owner.cookie);
  assert.equal(status.body.agents[0].state, 'connected');
  assert.equal(status.body.agents[0].lastEra, 'modern');

  // 改了配置就丢掉旧连接，下一次调用按新配置重连。
  const patched = await call(app, 'PATCH', '/api/agents', owner.cookie, {id, name: 'Dify 助手（改名）'});
  assert.equal(patched.body.agent.state, 'closed');

  // 凭据不落 agents.json。
  const raw = await readFile(join(app.dataDir, 'users', owner.user.id, '.data', 'agents.json'), 'utf8');
  assert.doesNotMatch(raw, /sk-http-secret/);
});

test('HTTP：非 owner 创建 stdio 返回 400 STDIO_OWNER_ONLY，配置页只给 HTTP，账号间互不可见', async t => {
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const owner = await ownerLogin(app);
  await post(app, '/api/agents', owner.cookie, httpAgent({name: 'owner 的 Agent'}));
  const member = await register(app, 'alice');

  const view = await call(app, 'GET', '/api/agents', member.cookie);
  assert.equal(view.status, 200);
  assert.equal(view.body.owner, false);
  assert.deepEqual(view.body.transports, ['http']);
  assert.deepEqual(view.body.agents, [], '看不到 owner 的 Agent');

  const stdio = await post(app, '/api/agents', member.cookie, {name: 'claude', transport: 'stdio', command: 'claude', args: ['mcp', 'serve']});
  assert.equal(stdio.status, 400);
  assert.equal(stdio.body.code, 'STDIO_OWNER_ONLY');

  const okHttp = await post(app, '/api/agents', member.cookie, httpAgent({name: 'alice 的 Agent'}));
  assert.equal(okHttp.status, 200);
  const patchStdio = await call(app, 'PATCH', '/api/agents', member.cookie, {id: okHttp.body.agent.id, transport: 'stdio', command: 'claude'});
  assert.equal(patchStdio.status, 400, '成员不能把已有 Agent 改成 stdio');
  assert.equal(patchStdio.body.code, 'STDIO_OWNER_ONLY');
});

test('HTTP：名称唯一、每用户最多 10 个、PATCH 与 DELETE', async t => {
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const owner = await ownerLogin(app);

  const first = await post(app, '/api/agents', owner.cookie, httpAgent());
  const duplicate = await post(app, '/api/agents', owner.cookie, httpAgent({name: 'dify 助手'}));
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.code, 'DUPLICATE_NAME');

  for (let i = 1; i < 10; i += 1) {
    const item = await post(app, '/api/agents', owner.cookie, httpAgent({name: 'Agent ' + i, url: 'https://a' + i + '.example.com/mcp'}));
    assert.equal(item.status, 200, JSON.stringify(item.body));
  }
  const over = await post(app, '/api/agents', owner.cookie, httpAgent({name: 'over'}));
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'AGENT_LIMIT');

  const patched = await call(app, 'PATCH', '/api/agents', owner.cookie, {id: first.body.agent.id, name: '改名', mrtr: {sampling: false, elicitation: false}, enabled: false});
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.agent.name, '改名');
  assert.deepEqual(patched.body.agent.mrtr, {sampling: false, elicitation: false});
  assert.equal(patched.body.agent.enabled, false);

  const removed = await call(app, 'DELETE', '/api/agents?id=' + first.body.agent.id, owner.cookie);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  const after = await call(app, 'GET', '/api/agents', owner.cookie);
  assert.equal(after.body.agents.some(agent => agent.id === first.body.agent.id), false);
});

test('HTTP：401 / 协商失败 / 超时给错误码与恢复建议；GET 状态同步', async t => {
  const authError = Object.assign(new Error('401 Unauthorized'), {code: 'CLIENT_HTTP_AUTHENTICATION', data: {status: 401}});
  const factory = fakeFactory({fail: authError});
  const app = await startApp(t, {agentClientFactory: factory});
  const owner = await ownerLogin(app);
  const created = await post(app, '/api/agents', owner.cookie, httpAgent());

  const tested = await post(app, '/api/agents/test', owner.cookie, {id: created.body.agent.id});
  assert.equal(tested.status, 200, '连接失败不伪装成 HTTP 500');
  assert.equal(tested.body.ok, false);
  assert.equal(tested.body.code, 'AUTH_FAILED');
  assert.ok(tested.body.recovery.length > 0);
  assert.equal(tested.body.agent.state, 'failed');
  assert.equal(tested.body.agent.lastError.code, 'AUTH_FAILED');

  const listed = await call(app, 'GET', '/api/agents', owner.cookie);
  assert.equal(listed.body.agents[0].state, 'failed');
  assert.equal(listed.body.agents[0].lastError.code, 'AUTH_FAILED');
  assert.ok(listed.body.agents[0].retryInMs > 0);
});

test('HTTP：空闲 30 分钟回收后下一次刷新自动重连（注入时钟）', async t => {
  let now = Date.parse('2026-10-26T02:00:00Z');
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory, agentNow: () => now});
  const owner = await ownerLogin(app);
  const created = await post(app, '/api/agents', owner.cookie, httpAgent());
  const id = created.body.agent.id;

  const tested = await post(app, '/api/agents/test', owner.cookie, {id});
  assert.equal(tested.body.agent.state, 'connected');
  assert.equal(factory.calls, 1);

  now += 30 * 60 * 1000 + 1;
  const recycled = await call(app, 'GET', '/api/agents', owner.cookie);
  assert.equal(recycled.body.agents[0].state, 'closed', 'GET 状态触发空闲回收');

  const refreshed = await post(app, '/api/agents/refresh', owner.cookie, {id});
  assert.equal(refreshed.body.ok, true, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.agent.state, 'connected');
  assert.equal(factory.calls, 2, '回收后下一次调用重新建连');

  const reconnected = await post(app, '/api/agents/reconnect', owner.cookie, {id});
  assert.equal(reconnected.body.ok, true, JSON.stringify(reconnected.body));
  assert.equal(reconnected.body.agent.state, 'connected');
  assert.equal(factory.calls, 3);
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 0);
});

test('HTTP：缺少 id / 未知 id / 刷新失败的状态语义', async t => {
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const owner = await ownerLogin(app);
  const missing = await post(app, '/api/agents/test', owner.cookie, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'MISSING_AGENT_ID');

  const unknown = await post(app, '/api/agents/refresh', owner.cookie, {id: '00000000-0000-7000-8000-000000000000'});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'AGENT_NOT_FOUND');
});
