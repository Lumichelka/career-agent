import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createApp} from '../src/server/app.mjs';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {RecruitStore} from '../src/recruit/store.mjs';
import {callTool} from '../src/tools/execute.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(root, 'src', 'mcp', 'stdio-bridge.mjs');

// 入站 /mcp 的接缝：真服务 + 真 SDK 客户端。只断言 HTTP 状态、JSON-RPC 结果与落盘可见的公开字段。
async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-inbound-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

async function register(app, name) {
  const res = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  assert.equal(res.status, 200, name + ' 注册失败');
  const {user} = await res.json();
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).join('; ');
  return {user, cookie};
}

function web(app, cookie, path, body) {
  return fetch(app.origin + '/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
}

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'raw-test', version: '1.0.0'}}
};

function rawMcp(app, {token, headers = {}} = {}) {
  return fetch(app.origin + '/mcp', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers},
    body: JSON.stringify(INITIALIZE)
  });
}

async function connect(app, token, mode, t) {
  const client = new Client({name: 'inbound-test', version: '1.0.0'}, {versionNegotiation: {mode}});
  t.after(async () => { await client.close().catch(() => {}); });
  const transport = new StreamableHTTPClientTransport(new URL(app.origin + '/mcp'), {
    authProvider: {token: async () => token}
  });
  await client.connect(transport);
  return client;
}

async function enabledApp(t) {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  const opened = await web(app, alice.cookie, 'mcp/switch', {enabled: true, confirm: true});
  assert.equal(opened.status, 200, '开启开关应成功');
  return {app, alice};
}

async function issue(app, cookie, name = 'claude-code') {
  const res = await web(app, cookie, 'mcp/clients', {name});
  assert.equal(res.status, 200, '签发凭据应成功');
  return res.json();
}

test('实例开关默认关：/mcp 返回 404，没有凭据也一样', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  const status = await (await web(app, alice.cookie, 'mcp')).json();
  assert.equal(status.enabled, false, '默认必须关闭');
  assert.equal((await rawMcp(app)).status, 404);
  assert.equal((await rawMcp(app, {token: 'zxmcp_deadbeef'})).status, 404, '关闭时先 404，不泄露凭据是否正确');
});

test('开启需要二次确认；任何登录用户确认后可开启，关闭不需要确认', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');

  const missing = await web(app, alice.cookie, 'mcp/switch', {enabled: true});
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, 'NEEDS_CONFIRMATION');
  assert.equal((await (await web(app, alice.cookie, 'mcp')).json()).enabled, false, '未确认不得开启');

  const bobOpened = await web(app, bob.cookie, 'mcp/switch', {enabled: true, confirm: true});
  assert.equal(bobOpened.status, 200, '非第一个账号也可以开启');
  assert.equal((await bobOpened.json()).enabled, true);

  // 开关与受众白名单是实例级配置，落在数据目录根部（不是某个用户目录）。
  const persisted = JSON.parse(await readFile(join(app.dataDir, 'mcp-inbound.json'), 'utf8'));
  assert.equal(persisted.enabled, true);
  assert.ok(persisted.audience.promised.includes('tailscale-https'));
  assert.ok(persisted.audience.loopbackHosts.includes('127.0.0.1'));
  assert.ok(persisted.audience.unverified.includes('lan-plaintext'));

  const closed = await web(app, alice.cookie, 'mcp/switch', {enabled: false});
  assert.equal(closed.status, 200, '关闭不需要确认');
  assert.equal((await closed.json()).enabled, false);
});

test('入站认证只认 Bearer：无 token、错 token、实例口令、登录 cookie 都 401', async t => {
  const {app, alice} = await enabledApp(t);

  assert.equal((await rawMcp(app)).status, 401);
  assert.equal((await rawMcp(app, {token: 'zxmcp_wrong'})).status, 401);
  const instanceOnly = await rawMcp(app, {headers: {'x-career-token': app.token}});
  assert.equal(instanceOnly.status, 401, '实例口令不能当入站凭据');
  const cookieOnly = await rawMcp(app, {headers: {cookie: alice.cookie}});
  assert.equal(cookieOnly.status, 401, '登录 cookie 不能当入站凭据');
});

test('有效凭据：modern 初始化、ListTools、CallTool 都可用', async t => {
  const {app, alice} = await enabledApp(t);
  const issued = await issue(app, alice.cookie);
  assert.match(issued.token, /^zxmcp_[a-f0-9]{48}$/);

  const client = await connect(app, issued.token, 'auto', t);
  assert.equal(client.getProtocolEra(), 'modern', 'auto 应协商到 modern');

  const {tools} = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('company_list'), '应暴露本地只读工具');
  assert.ok(!names.some(name => name.startsWith('career_platform_')), '任务内平台工具不属于入站工具面');

  const result = await client.callTool({name: 'company_list', arguments: {}});
  assert.ok(!result.isError, '成功调用不应标记 isError');
  assert.equal(result.content[0].type, 'text');
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, 'readable');
  assert.deepEqual(body.companies, []);
});

test('有效凭据：legacy 客户端也能初始化、ListTools、CallTool', async t => {
  const {app, alice} = await enabledApp(t);
  const {token} = await issue(app, alice.cookie);

  const client = await connect(app, token, 'legacy', t);
  assert.equal(client.getProtocolEra(), 'legacy');
  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'company_list'));
  const result = await client.callTool({name: 'company_list', arguments: {}});
  assert.equal(JSON.parse(result.content[0].text).status, 'readable');
});

test('撤销后立即 401；重新生成后旧 token 失效、新 token 可用', async t => {
  const {app, alice} = await enabledApp(t);
  const first = await issue(app, alice.cookie, 'cursor');

  const revoked = await web(app, alice.cookie, 'mcp/clients/revoke', {id: first.client.id});
  assert.equal(revoked.status, 200);
  assert.equal((await rawMcp(app, {token: first.token})).status, 401, '撤销立即生效');
  const afterRevoke = await web(app, alice.cookie, 'mcp/clients/regenerate', {id: first.client.id});
  assert.equal(afterRevoke.status, 409, '已撤销的 client 不能原地重新生成');

  const second = await issue(app, alice.cookie, 'vscode');
  const regenerated = await web(app, alice.cookie, 'mcp/clients/regenerate', {id: second.client.id});
  assert.equal(regenerated.status, 200);
  const next = await regenerated.json();
  assert.notEqual(next.token, second.token);
  assert.equal((await rawMcp(app, {token: second.token})).status, 401, '旧 token 必须立即失效');
  assert.equal((await rawMcp(app, {token: next.token})).status, 200, '新 token 可用');
});

test('三种宿主片段格式正确；Codex 片段不内联 token', async t => {
  const {app, alice} = await enabledApp(t);
  const issued = await issue(app, alice.cookie);
  const snippets = issued.snippets;
  assert.equal(snippets.length, 3);

  const claude = snippets.find(s => s.id === 'claude-code');
  assert.match(claude.content, /^claude mcp add --transport http /);
  assert.ok(claude.content.includes(app.origin + '/mcp'));
  assert.ok(claude.content.includes(issued.token), 'Claude Code 片段需要可粘贴的凭据');

  const cursor = snippets.find(s => s.id === 'cursor-vscode');
  assert.equal(cursor.format, 'json');
  const parsed = JSON.parse(cursor.content);
  const server = parsed.mcpServers['career-agent'];
  assert.equal(server.url, app.origin + '/mcp');
  assert.equal(server.headers.Authorization, 'Bearer ' + issued.token);

  const codex = snippets.find(s => s.id === 'codex');
  assert.equal(codex.format, 'toml');
  assert.match(codex.content, /bearer_token_env_var = "CAREER_MCP_TOKEN"/);
  assert.ok(!codex.content.includes(issued.token), 'Codex 片段不得内联凭据');
  assert.ok(codex.note.includes('CAREER_MCP_TOKEN'));
});

test('状态只显前缀：完整 token 与哈希都不回传', async t => {
  const {app, alice} = await enabledApp(t);
  const issued = await issue(app, alice.cookie, 'claude-code');
  const status = await (await web(app, alice.cookie, 'mcp')).json();
  assert.equal(status.clients.length, 1);
  const client = status.clients[0];
  assert.equal(client.name, 'claude-code');
  assert.ok(client.tokenPrefix.startsWith('zxmcp_'));
  assert.ok(issued.token.startsWith(client.tokenPrefix));
  assert.ok(!JSON.stringify(status).includes(issued.token), '完整 token 只能出现一次');
  assert.ok(!JSON.stringify(status).toLowerCase().includes('hash'), '哈希不对外');
  assert.ok(client.createdAt);
  assert.equal(client.toolCount > 0, true);

  // 落盘只存 sha256 哈希，完整凭据不在用户目录里留下第二份。
  const stored = await readFile(join(app.dataDir, 'users', alice.user.id, 'mcp-clients.json'), 'utf8');
  assert.ok(!stored.includes(issued.token), '用户目录不得保存完整凭据');
  assert.ok(stored.includes(createHash('sha256').update(issued.token).digest('hex')), '应保存 sha256 哈希');
});

test('关闭开关不撤销已签凭据；重新开启后旧凭据仍然可用', async t => {
  const {app, alice} = await enabledApp(t);
  const {token} = await issue(app, alice.cookie, 'keep-me');

  assert.equal((await web(app, alice.cookie, 'mcp/switch', {enabled: false})).status, 200);
  assert.equal((await rawMcp(app, {token})).status, 404, '关闭后端点不存在');
  const status = await (await web(app, alice.cookie, 'mcp')).json();
  assert.equal(status.clients[0].revoked, false, '关闭开关不撤销凭据');
  assert.match(status.audience.note, /127\.0\.0\.1|未验证/);
  assert.ok(status.audience.promised.some(url => url.endsWith('/mcp')));
  assert.ok(status.audience.unverified.some(url => url.includes('局域网')));

  assert.equal((await web(app, alice.cookie, 'mcp/switch', {enabled: true, confirm: true})).status, 200);
  assert.equal((await rawMcp(app, {token})).status, 200, '重新开启后原凭据恢复可用');
});

test('stdio-only 宿主经随包桥接到 /mcp：ListTools、CallTool 都可用', async t => {
  const {app, alice} = await enabledApp(t);
  const {token} = await issue(app, alice.cookie, 'stdio-host');

  const client = new Client({name: 'stdio-host-test', version: '1.0.0'}, {versionNegotiation: {mode: 'legacy'}});
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    env: {...process.env, CAREER_MCP_URL: app.origin + '/mcp', CAREER_MCP_TOKEN: token},
    stderr: 'pipe'
  }));

  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'company_list'), '桥应转发入站工具列表');
  const result = await client.callTool({name: 'company_list', arguments: {}});
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).status, 'readable');
});

test('career_feed 入站 MCP 与 /chat 读同一用户数据，rawText 默认不带', async t => {
  const {app, alice} = await enabledApp(t);
  const {token} = await issue(app, alice.cookie, 'feed-client');
  const tenantDir = join(app.dataDir, 'users', alice.user.id, '.data');
  const store = RecruitStore.open(join(tenantDir, 'recruit.db'));
  store.upsertEvent({
    id: 'f'.repeat(24), sourceId: 'manual', school: '测试大学', city: '成都', kind: '宣讲会',
    title: 'MCP 信息流活动', company: '信息流公司', startAt: '2026-12-10T14:00:00+08:00',
    fetchedAt: new Date().toISOString(), confidence: 0.8, rawText: '联系人 张三 电话 13800138000'
  });
  store.close();

  const client = await connect(app, token, 'auto', t);
  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'career_feed'), '入站工具面应暴露 career_feed');

  const viaMcp = await client.callTool({name: 'career_feed', arguments: {}});
  assert.ok(!viaMcp.isError);
  const feed = JSON.parse(viaMcp.content[0].text);
  assert.equal(feed.status, 'readable');
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].record.title, 'MCP 信息流活动');
  assert.equal(feed.entries[0].rawText, undefined, 'rawText 默认不返回');

  const direct = await callTool('career_feed', {}, {config: {recruitDir: tenantDir, dataDir: tenantDir, userId: alice.user.id}});
  assert.deepEqual(feed.entries, direct.entries, '入站 MCP 与 /chat 必须读到同一份数据');
  assert.equal(feed.nextCursor, direct.nextCursor);

  const withRaw = await client.callTool({name: 'career_feed', arguments: {includeRawText: true}});
  const raw = JSON.parse(withRaw.content[0].text);
  assert.ok(raw.entries[0].rawText);
  assert.ok(!raw.entries[0].rawText.includes('13800138000'), '显式请求原文时也要脱敏');
});

test('stdio 桥缺少配置时直接退出并说明原因', async () => {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {...process.env, CAREER_MCP_URL: '', CAREER_MCP_TOKEN: ''},
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /缺少入站桥接配置/);
});
