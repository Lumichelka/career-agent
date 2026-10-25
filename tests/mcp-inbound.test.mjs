import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const STDIO_BRIDGE = join(root, 'src', 'mcp', 'stdio-bridge.mjs');

// 每个用例一条独立实例：临时数据目录 + 系统分配端口，结束关闭并清目录。
async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-mcp-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

async function call(app, path, {method = 'GET', body, cookie} = {}) {
  const headers = {'x-career-token': app.token};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(app.origin + path, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = {raw: text}; }
  return {status: res.status, body: json, headers: res.headers};
}

async function register(app, name) {
  const res = await call(app, '/api/auth/register', {method: 'POST', body: {name, password: 'correct-horse-battery'}});
  assert.equal(res.status, 200, name + ' 注册失败：' + JSON.stringify(res.body));
  const cookie = res.headers.getSetCookie().join('; ');
  return {user: res.body.user, cookie};
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'raw-test', version: '1.0.0'}}
};

// 直接打 /mcp：用来断言 404 / 401 这类认证面，不依赖 SDK 客户端的内部重试。
async function rawMcp(app, {token, cookie, instanceToken, body = INIT, method = 'POST', headers = {}} = {}) {
  const h = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers};
  if (token) h.Authorization = 'Bearer ' + token;
  if (cookie) h.cookie = cookie;
  if (instanceToken) h['x-career-token'] = instanceToken;
  const res = await fetch(app.origin + '/mcp', {method, headers: h, ...(method === 'POST' ? {body: JSON.stringify(body)} : {})});
  return {status: res.status, headers: res.headers, text: await res.text()};
}

const getStatus = async (app, cookie) => (await call(app, '/api/mcp', {cookie})).body;
const setSwitch = (app, cookie, body) => call(app, '/api/mcp/switch', {method: 'POST', body, cookie});
const createClient = (app, cookie, name) => call(app, '/api/mcp/clients', {method: 'POST', body: {name}, cookie});

async function enableInbound(app, cookie) {
  const out = await setSwitch(app, cookie, {enabled: true, confirm: true});
  assert.equal(out.status, 200, '开启失败：' + JSON.stringify(out.body));
  return out.body;
}

// 一个真实的 MCP 客户端：auto 协商 modern，legacy 走 2025 握手。
async function connect(t, app, token, mode = 'auto') {
  const client = new Client({name: 'career-inbound-test', version: '1.0.0'}, {versionNegotiation: {mode}});
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.origin + '/mcp'), {authProvider: {token: async () => token}}));
  return client;
}

test('默认关：/mcp 回 404，状态接口把受众与 unverified 写清楚', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');

  assert.equal((await rawMcp(app, {body: INIT})).status, 404, '默认关时 POST 应 404');
  assert.equal((await rawMcp(app, {method: 'GET'})).status, 404, '默认关时 GET 也应 404');

  const status = await getStatus(app, alice.cookie);
  assert.equal(status.enabled, false);
  assert.equal(status.url, app.origin + '/mcp');
  assert.equal(status.audience.promised[0], app.origin + '/mcp');
  assert.ok(status.audience.promised.some(s => /Tailscale HTTPS/.test(s)), '应承诺 Tailscale HTTPS');
  assert.ok(status.audience.unverified.some(s => /局域网明文/.test(s)), '局域网明文必须标未验证');
  assert.deepEqual(status.clients, []);
});

test('任何登录用户可开，但要二次确认：未确认 409 且开关不动', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  const status = await getStatus(app, alice.cookie);
  assert.ok(status.enabledBy === '' || typeof status.enabledBy === 'string');

  const denied = await setSwitch(app, alice.cookie, {enabled: true});
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'NEEDS_CONFIRMATION');
  assert.match(denied.body.warning, /凭据/);
  assert.equal((await rawMcp(app, {body: INIT})).status, 404, '未确认前开关仍是关的');

  const on = await enableInbound(app, alice.cookie);
  assert.equal(on.enabled, true);
  assert.equal(on.enabledBy, 'alice');
  assert.ok(on.enabledAt);

  const anonymous = await rawMcp(app, {body: INIT});
  assert.equal(anonymous.status, 401, '开启后无 token 应 401');
  assert.match(anonymous.headers.get('www-authenticate') || '', /Bearer/);
  assert.equal((await rawMcp(app, {token: 'zxmcp_' + 'a'.repeat(48)})).status, 401, '未知 token 应 401');
  assert.equal((await rawMcp(app, {cookie: alice.cookie, instanceToken: app.token})).status, 401, '登录 cookie 与实例口令不能当入站凭据');

  const off = await setSwitch(app, alice.cookie, {enabled: false});
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal((await rawMcp(app, {body: INIT})).status, 404, '关闭后立即 404');
});

test('签发凭据：完整凭据只回一次，之后只显前缀；三种宿主片段格式正确', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);

  const made = await createClient(app, alice.cookie, 'Claude Code');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const {client, token, snippets} = made.body;
  assert.match(token, /^zxmcp_[a-f0-9]{48}$/);
  assert.ok(token.startsWith(client.tokenPrefix), '只显示的前缀必须来自真实凭据');
  assert.ok(client.toolCount > 0, '签发时应记录工具集快照');
  assert.ok(client.tools.includes('resume_list'));
  assert.ok(!JSON.stringify(client).includes(token), 'client 记录里不能出现完整凭据');

  const byId = Object.fromEntries(snippets.map(s => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['claude-code', 'codex', 'cursor-vscode']);

  assert.equal(byId['claude-code'].format, 'shell');
  assert.equal(
    byId['claude-code'].content,
    'claude mcp add --transport http career-agent ' + app.origin + '/mcp --header "Authorization: Bearer ' + token + '"'
  );

  const cursor = JSON.parse(byId['cursor-vscode'].content);
  assert.equal(cursor.mcpServers['career-agent'].type, 'http');
  assert.equal(cursor.mcpServers['career-agent'].url, app.origin + '/mcp');
  assert.equal(cursor.mcpServers['career-agent'].headers.Authorization, 'Bearer ' + token);

  assert.equal(byId.codex.format, 'toml');
  assert.match(byId.codex.content, /\[mcp_servers\.career-agent\]/);
  assert.match(byId.codex.content, /url = "http:\/\/127\.0\.0\.1:\d+\/mcp"/);
  assert.match(byId.codex.content, /bearer_token_env_var = "CAREER_MCP_TOKEN"/);
  assert.ok(!byId.codex.content.includes(token), 'Codex 片段不能内联 token');
  assert.ok(!/Authorization/i.test(byId.codex.content), 'Codex 片段不能内联 Authorization 头');
  assert.match(byId.codex.note, /环境变量 CAREER_MCP_TOKEN/, '要说明凭据从环境变量来');
  assert.equal(byId.codex.envVar, 'CAREER_MCP_TOKEN');

  const status = await getStatus(app, alice.cookie);
  assert.equal(status.clients.length, 1);
  assert.equal(status.clients[0].tokenPrefix, client.tokenPrefix);
  assert.equal(status.clients[0].revoked, false);
  assert.ok(!JSON.stringify(status).includes(token), '状态接口不能再返回完整凭据');
});

test('凭据只落哈希：账号目录里没有可用的明文 token', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);
  const made = await createClient(app, alice.cookie, 'claude-code');
  const token = made.body.token;

  const raw = await readFile(join(app.dataDir, 'users', alice.user.id, '.data', 'mcp-clients.json'), 'utf8');
  assert.ok(!raw.includes(token), '落盘文件不能包含完整凭据');
  const [record] = JSON.parse(raw);
  assert.match(record.hash, /^[a-f0-9]{64}$/, '只存 SHA-256 哈希');
  assert.equal(record.prefix, made.body.client.tokenPrefix);
  assert.ok(Array.isArray(record.tools) && record.tools.includes('resume_list'), '记录签发时的工具集快照');
});

for (const mode of ['auto', 'legacy']) {
  test('入站 ' + mode + ' 时代：初始化、ListTools、CallTool 都可用', async t => {
    const app = await startApp(t);
    const alice = await register(app, 'alice');
    await enableInbound(app, alice.cookie);
    const made = await createClient(app, alice.cookie, 'host-' + mode);

    const client = await connect(t, app, made.body.token, mode);
    assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');

    const {tools} = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.ok(names.includes('resume_list'));
    assert.ok(!names.some(name => name.startsWith('career_platform_')), '平台工具是任务内操作，不进入入站列表');
    const resumeTool = tools.find(tool => tool.name === 'resume_list');
    assert.equal(resumeTool.annotations?.readOnlyHint, true);
    assert.ok(resumeTool.inputSchema, '应带参数 schema');

    const result = await client.callTool({name: 'resume_list', arguments: {}});
    assert.ok(!result.isError, '成功调用不应标记 isError');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.status, 'readable');
    assert.deepEqual(payload.resumes, []);

    // 工具参数错误按工具失败返回，连接不断。
    const invalid = await client.callTool({name: 'career_recruit_project', arguments: {}});
    assert.equal(invalid.isError, true);
    assert.equal(JSON.parse(invalid.content[0].text).code, 'INVALID_ARGUMENTS');
    assert.equal((await client.listTools()).tools.length, tools.length, '一次失败后连接仍可用');

    // 未知工具是协议层错误，不是一次失败调用。
    await assert.rejects(() => client.callTool({name: 'career_platform_status', arguments: {}}), /未知工具/);
  });
}

test('撤销立即 401：活着的连接下一次调用就断，已撤销的 client 不能重新生成', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);
  const made = await createClient(app, alice.cookie, 'cursor');
  const client = await connect(t, app, made.body.token, 'auto');
  assert.equal((await client.listTools()).tools.length > 0, true);

  const revoked = await call(app, '/api/mcp/clients/revoke', {method: 'POST', body: {id: made.body.client.id}, cookie: alice.cookie});
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.client.revoked, true);

  assert.equal((await rawMcp(app, {token: made.body.token})).status, 401, '撤销后立刻 401');
  await assert.rejects(() => client.listTools(), '已建立的连接下一次请求应被拒');

  const regen = await call(app, '/api/mcp/clients/regenerate', {method: 'POST', body: {id: made.body.client.id}, cookie: alice.cookie});
  assert.equal(regen.status, 409);
  assert.equal(regen.body.code, 'CLIENT_REVOKED');

  const status = await getStatus(app, alice.cookie);
  assert.equal(status.clients[0].revoked, true);
  assert.ok(status.clients[0].revokedAt);
});

test('重新生成：旧 token 立即失效，client 身份与工具集快照不变', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);
  const made = await createClient(app, alice.cookie, 'vs-code');
  const before = made.body.client;

  const regenerated = await call(app, '/api/mcp/clients/regenerate', {method: 'POST', body: {id: before.id}, cookie: alice.cookie});
  assert.equal(regenerated.status, 200);
  const after = regenerated.body.client;
  assert.equal(after.id, before.id, '同一 client 身份');
  assert.notEqual(regenerated.body.token, made.body.token);
  assert.notEqual(after.tokenPrefix, before.tokenPrefix);
  assert.deepEqual(after.tools, before.tools);
  assert.ok(regenerated.body.snippets.length === 3);

  assert.equal((await rawMcp(app, {token: made.body.token})).status, 401, '旧 token 失效');
  const client = await connect(t, app, regenerated.body.token, 'legacy');
  assert.equal((await client.listTools()).tools.length > 0, true);

  const status = await getStatus(app, alice.cookie);
  assert.equal(status.clients.length, 1, '重新生成不新增 client 记录');
  assert.equal(status.clients[0].tokenPrefix, after.tokenPrefix);
});

test('关闭开关不撤销已签凭据：重新开启后原 token 仍可用', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);
  const made = await createClient(app, alice.cookie, 'codex');
  const token = made.body.token;

  const off = await setSwitch(app, alice.cookie, {enabled: false});
  assert.equal(off.status, 200);
  assert.equal((await rawMcp(app, {token, body: INIT})).status, 404, '关闭时即使带 token 也 404');
  const status = await getStatus(app, alice.cookie);
  assert.equal(status.enabled, false);
  assert.equal(status.clients.length, 1);
  assert.equal(status.clients[0].revoked, false, '关闭开关不撤销凭据');

  await enableInbound(app, alice.cookie);
  const client = await connect(t, app, token, 'auto');
  assert.equal((await client.listTools()).tools.length > 0, true, '原凭据重新开启后仍可用');
});

test('凭据与开关跨重启保留：凭据不自动过期', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-mcp-restart-'));
  const first = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  const alice = await register(first, 'alice');
  await enableInbound(first, alice.cookie);
  const made = await createClient(first, alice.cookie, 'claude-code');
  await first.close();

  const second = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await second.close(); await rm(dir, {recursive: true, force: true}); });

  const login = await call(second, '/api/auth/login', {method: 'POST', body: {name: 'alice', password: 'correct-horse-battery'}});
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().join('; ');
  const status = await getStatus(second, cookie);
  assert.equal(status.enabled, true, '开关应保留');
  assert.equal(status.clients[0].tokenPrefix, made.body.client.tokenPrefix);
  assert.equal(status.clients[0].revoked, false);

  const client = await connect(t, second, made.body.token, 'auto');
  assert.equal((await client.listTools()).tools.length > 0, true, '重启后凭据仍可用');
  const used = await getStatus(second, cookie);
  assert.ok(used.clients[0].lastUsedAt, '应记录最近使用时间');
});

test('两个账号的凭据与数据互不可见', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  await enableInbound(app, alice.cookie);
  const aliceClient = await createClient(app, alice.cookie, 'alice-laptop');
  const bobClient = await createClient(app, bob.cookie, 'bob-laptop');

  const created = await call(app, '/api/resumes', {method: 'POST', body: {name: 'Alice 的简历', title: '基础版', content: '只有 alice 能看到'}, cookie: alice.cookie});
  assert.equal(created.status, 200);

  const readAs = async token => {
    const client = await connect(t, app, token, 'auto');
    const result = await client.callTool({name: 'resume_list', arguments: {}});
    return JSON.parse(result.content[0].text).resumes;
  };
  assert.equal((await readAs(aliceClient.body.token)).length, 1, 'alice 的凭据读到自己账号的数据');
  assert.equal((await readAs(bobClient.body.token)).length, 0, 'bob 的凭据读不到 alice 的数据');

  const aliceStatus = await getStatus(app, alice.cookie);
  const bobStatus = await getStatus(app, bob.cookie);
  assert.deepEqual(aliceStatus.clients.map(c => c.name), ['alice-laptop']);
  assert.deepEqual(bobStatus.clients.map(c => c.name), ['bob-laptop']);
});

test('随包 stdio 桥：只用 stdio 的宿主也能连上 /mcp', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await enableInbound(app, alice.cookie);
  const made = await createClient(app, alice.cookie, 'claude-desktop');

  const client = new Client({name: 'stdio-bridge-test', version: '1.0.0'}, {versionNegotiation: {mode: 'legacy'}});
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [STDIO_BRIDGE],
    env: {...process.env, CAREER_MCP_URL: app.origin + '/mcp', CAREER_MCP_TOKEN: made.body.token},
    stderr: 'pipe'
  }));

  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'resume_list'), '桥应转出本应用的工具列表');
  const result = await client.callTool({name: 'resume_list', arguments: {}});
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).status, 'readable');
});

test('桥缺配置：进程直接退出并说明原因', async t => {
  const {spawn} = await import('node:child_process');
  const child = spawn(process.execPath, [STDIO_BRIDGE], {env: {...process.env, CAREER_MCP_URL: '', CAREER_MCP_TOKEN: ''}, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /CAREER_MCP_URL/);
});
