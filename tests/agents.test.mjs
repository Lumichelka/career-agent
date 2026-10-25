import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KeyVault} from '../src/model/keyvault.mjs';
import {AgentConfig, MAX_AGENTS} from '../src/agents/config.mjs';
import {
  AgentConnectionManager, TOOL_CACHE_MS, IDLE_MS,
  mapConnectionError, safeStdioEnv, stdioSpawnOptions, killProcessTree
} from '../src/mcp/client.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-agents-'));
  const home = join(dir, 'users', 'u1');
  const dataDir = join(home, '.data');
  const vault = await new KeyVault(dataDir).init();
  const config = await new AgentConfig(home, vault).load();
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, home, dataDir, vault, config};
}

function clock(start = Date.parse('2026-10-26T02:00:00Z')) {
  let value = start;
  const now = () => value;
  now.advance = ms => { value += ms; };
  return now;
}

function fakeTimer() {
  const jobs = new Map();
  let next = 0;
  return {
    jobs,
    setTimeout(fn, ms) { next += 1; jobs.set(next, {fn, ms}); return next; },
    clearTimeout(id) { jobs.delete(id); },
    async runAll() {
      const list = [...jobs.values()];
      jobs.clear();
      for (const job of list) job.fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

// 假连接：只模拟外部 MCP server 的可见行为（connect / listTools / callTool / close），不联网。
function fakeFactory(log, options = {}) {
  const factory = async context => {
    factory.calls += 1;
    const index = factory.calls;
    log.push({kind: 'context', index, ...context});
    return {
      pid: null,
      era: () => options.era || 'modern',
      serverInfo: () => ({name: 'fake-mcp', version: '1.0.0'}),
      connect: async () => {
        log.push({kind: 'connect', index});
        if (options.fail) throw options.fail;
      },
      listTools: async () => {
        log.push({kind: 'listTools', index});
        if (options.listFail) throw options.listFail;
        return {tools: (options.tools || [
          {name: 'search', title: '搜索', annotations: {readOnlyHint: true}},
          {name: 'write_note'}
        ]).map(tool => ({...tool}))};
      },
      callTool: async () => { log.push({kind: 'callTool', index}); return {content: []}; },
      close: async () => { log.push({kind: 'close', index}); }
    };
  };
  factory.calls = 0;
  return factory;
}

const kinds = log => log.filter(item => item.kind !== 'context').map(item => item.kind);

test('配置：HTTP Agent 凭据进 KeyVault，公开视图只给掩码', async t => {
  const {home, dataDir, vault, config} = await setup(t);
  const agent = await config.create({
    name: 'Dify 助手',
    transport: 'http',
    url: 'https://user:pass@dify.example.com/mcp?token=abc',
    token: 'sk-http-secret',
    headerName: '',
    allowPrivateHttp: false
  }, {isOwner: true});

  const view = config.list()[0];
  assert.equal(view.name, 'Dify 助手');
  assert.equal(view.transport, 'http');
  assert.equal(view.http.url, 'https://dify.example.com/mcp');
  assert.equal(view.hasToken, true);
  assert.equal(view.http.hasUrlCredentials, true);
  assert.equal(view.tokenMask, '••••••');
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /pass|token=abc|sk-http-secret/);
  assert.equal(view.http.url.includes('user'), false);

  const raw = await readFile(join(dataDir, 'agents.json'), 'utf8');
  assert.doesNotMatch(raw, /pass|token=abc|sk-http-secret/);
  assert.equal(vault.get('agent.' + agent.id + '.token'), 'sk-http-secret');
  assert.match(vault.get('agent.' + agent.id + '.url'), /token=abc/);
  assert.equal(config.credentialsFor(agent.id).token, 'sk-http-secret');
  assert.equal(config.credentialsFor(agent.id).url, 'https://user:pass@dify.example.com/mcp?token=abc');
  assert.equal(home.length > 0, true);
});

test('配置：名称唯一、每用户最多 10 个、stdio 仅 owner', async t => {
  const {config} = await setup(t);
  await assert.rejects(
    config.create({name: 'A', transport: 'stdio', command: 'claude', args: ['mcp', 'serve']}, {isOwner: false}),
    error => error.code === 'STDIO_OWNER_ONLY' && error.status === 400,
    '非 owner 创建 stdio 必须 400 STDIO_OWNER_ONLY'
  );
  const stdio = await config.create({
    name: 'Claude Code', transport: 'stdio', command: 'claude', args: ['mcp', 'serve'],
    env: {COZE_API_TOKEN: 'env-secret'}, mrtr: {sampling: false}
  }, {isOwner: true});
  assert.deepEqual(stdio.stdio.envKeys, ['COZE_API_TOKEN']);
  assert.deepEqual(stdio.mrtr, {sampling: false, elicitation: true});
  assert.doesNotMatch(JSON.stringify(stdio), /env-secret/);
  assert.equal(config.credentialsFor(stdio.id).env.COZE_API_TOKEN, 'env-secret');
  const merged = await config.update(stdio.id, {env: {NEW_TOKEN: 'new-secret'}}, {isOwner: true});
  assert.deepEqual(merged.stdio.envKeys.sort(), ['COZE_API_TOKEN', 'NEW_TOKEN']);
  assert.equal(config.credentialsFor(stdio.id).env.COZE_API_TOKEN, 'env-secret');
  const removed = await config.update(stdio.id, {removeEnv: ['NEW_TOKEN']}, {isOwner: true});
  assert.deepEqual(removed.stdio.envKeys, ['COZE_API_TOKEN']);

  await assert.rejects(
    config.create({name: 'claude code', transport: 'http', url: 'https://a.example.com/mcp'}, {isOwner: true}),
    error => error.code === 'DUPLICATE_NAME'
  );
  for (let i = config.agents.length; i < MAX_AGENTS; i += 1) {
    await config.create({name: 'A' + i, transport: 'http', url: 'https://a' + i + '.example.com/mcp'}, {isOwner: true});
  }
  await assert.rejects(
    config.create({name: 'over', transport: 'http', url: 'https://over.example.com/mcp'}, {isOwner: true}),
    error => error.code === 'AGENT_LIMIT'
  );
});

test('配置：HTTP URL 复用 providers.validateEndpoint 语义（公网 HTTPS，私网 HTTP 需显式允许）', async t => {
  const {config} = await setup(t);
  await assert.rejects(
    config.create({name: 'plain', transport: 'http', url: 'http://public.example.com/mcp'}, {isOwner: true}),
    error => error.code === 'INVALID_URL' && /HTTPS|https/.test(error.message)
  );
  await assert.rejects(
    config.create({name: 'lan', transport: 'http', url: 'http://192.168.1.9:8080/mcp'}, {isOwner: true}),
    error => error.code === 'INVALID_URL' && /局域网/.test(error.message)
  );
  const lan = await config.create({name: 'lan ok', transport: 'http', url: 'http://192.168.1.9:8080/mcp', allowPrivateHttp: true}, {isOwner: true});
  assert.equal(lan.http.url, 'http://192.168.1.9:8080/mcp');
});

test('配置：更新与删除；改名字不误删 URL 里的凭据，删除清空 KeyVault', async t => {
  const {vault, config} = await setup(t);
  const agent = await config.create({name: 'A', transport: 'http', url: 'https://x.example.com/mcp?k=v', token: 'sk-1'}, {isOwner: true});
  const renamed = await config.update(agent.id, {name: 'B', enabled: false}, {isOwner: true});
  assert.equal(renamed.name, 'B');
  assert.equal(renamed.enabled, false);
  assert.equal(renamed.http.hasUrlCredentials, true, '只改名字不能丢掉 URL 凭据');
  assert.equal(renamed.hasToken, true);
  assert.equal(vault.get('agent.' + agent.id + '.token'), 'sk-1');

  // 界面只拿得到脱敏地址；把脱敏地址原样回存不能清掉 URL 里的凭据。
  const resaved = await config.update(agent.id, {url: renamed.http.url}, {isOwner: true});
  assert.equal(resaved.http.hasUrlCredentials, true);

  await config.update(agent.id, {clearToken: true}, {isOwner: true});
  assert.equal(vault.has('agent.' + agent.id + '.token'), false);
  await config.remove(agent.id);
  assert.deepEqual(config.list(), []);
  assert.equal(vault.labels().filter(name => name.startsWith('agent.' + agent.id + '.')).length, 0);
});

test('连接：测试连接只 connect + listTools，绝不调用工具；记录 era、serverInfo 与最近连接时间', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({name: 'HTTP', transport: 'http', url: 'https://agent.example.com/mcp', token: 'sk-1'}, {isOwner: true});
  const log = [];
  const now = clock();
  const manager = new AgentConnectionManager({home, config, createConnection: fakeFactory(log), now, timer: fakeTimer()});
  t.after(() => manager.closeAll());

  const status = await manager.test(agent.id);
  assert.deepEqual(kinds(log), ['connect', 'listTools'], '测试连接只连接与发现');
  assert.equal(status.state, 'connected');
  assert.equal(status.era, 'modern');
  assert.deepEqual(status.serverInfo, {name: 'fake-mcp', version: '1.0.0'});
  assert.equal(status.tools.length, 2);
  assert.equal(status.tools.find(tool => tool.name === 'search').readOnly, true);
  assert.equal(status.tools.find(tool => tool.name === 'write_note').readOnly, false);
  assert.ok(status.lastConnectedAt);
  const saved = config.agents.find(item => item.id === agent.id);
  assert.ok(saved.lastConnectedAt, 'lastConnectedAt 写回配置');
  assert.equal(saved.lastEra, 'modern');
  // 连接上下文：凭据只在服务端，cwd 锁在用户 home。
  const context = log.find(item => item.kind === 'context');
  assert.equal(context.home, home);
  assert.equal(context.credentials.token, 'sk-1');
  assert.equal(context.mrtr.sampling, true);
  assert.equal(manager.records.get(agent.id).connection !== null, true);
});

test('发现缓存：10 分钟内复用，pin 快照不受刷新影响', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({name: 'HTTP', transport: 'http', url: 'https://agent.example.com/mcp'}, {isOwner: true});
  const log = [];
  const options = {};
  const now = clock();
  const manager = new AgentConnectionManager({home, config, createConnection: fakeFactory(log, options), now, timer: fakeTimer()});
  t.after(() => manager.closeAll());

  const first = await manager.tools(agent.id);
  assert.equal(first.length, 2);
  const connectCount = log.filter(item => item.kind === 'connect').length;
  const listCount = log.filter(item => item.kind === 'listTools').length;
  await manager.tools(agent.id);
  assert.equal(log.filter(item => item.kind === 'connect').length, connectCount, '缓存期不重连');
  assert.equal(log.filter(item => item.kind === 'listTools').length, listCount, '缓存期不重新发现');

  const pinned = await manager.pin(agent.id);
  options.tools = [{name: 'new_tool', annotations: {readOnlyHint: true}}];
  now.advance(TOOL_CACHE_MS + 1);
  const refreshed = await manager.refresh(agent.id);
  assert.deepEqual(refreshed.tools.map(tool => tool.name), ['new_tool']);
  assert.deepEqual(pinned.map(tool => tool.name), ['search', 'write_note'], 'pin 的任务快照不随刷新漂移');
  assert.deepEqual(manager.pinned(agent.id).map(tool => tool.name), ['search', 'write_note']);
  assert.equal(log.filter(item => item.kind === 'listTools').length, listCount + 1);
});

test('空闲回收：30 分钟后连接关闭，下一次调用自动重连；注入的定时器也能触发', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({name: 'HTTP', transport: 'http', url: 'https://agent.example.com/mcp'}, {isOwner: true});
  const log = [];
  const now = clock();
  const timer = fakeTimer();
  const manager = new AgentConnectionManager({home, config, createConnection: fakeFactory(log), now, timer});
  t.after(() => manager.closeAll());

  await manager.test(agent.id);
  assert.equal(manager.records.get(agent.id).state, 'connected');
  now.advance(IDLE_MS + 1);
  const status = await manager.status(agent.id);
  assert.equal(status.state, 'closed', '空闲 30 分钟回收');
  assert.equal(kinds(log).includes('close'), true);
  assert.equal(status.lastConnectedAt.length > 0, true);
  await manager.tools(agent.id);
  assert.equal(log.filter(item => item.kind === 'connect').length, 2, '下一次调用自动重连');
  assert.equal(manager.records.get(agent.id).state, 'connected');

  // 定时器路径：不手动调 status，只让注入的 timer 跑回调。
  now.advance(IDLE_MS + 2);
  await timer.runAll();
  assert.equal(manager.records.get(agent.id).state, 'closed');
});

test('错误映射：401 / 协商失败 / 超时分别给错误码与恢复建议；退避最多 3 次 / 10 分钟', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({name: 'HTTP', transport: 'http', url: 'https://agent.example.com/mcp'}, {isOwner: true});
  const now = clock();
  const authError = Object.assign(new Error('401 Unauthorized'), {code: 'CLIENT_HTTP_AUTHENTICATION', data: {status: 401}});
  const factory = fakeFactory([], {fail: authError});
  const manager = new AgentConnectionManager({home, config, createConnection: factory, now, timer: fakeTimer()});
  t.after(() => manager.closeAll());

  const first = await manager.test(agent.id).then(() => null, error => error);
  assert.equal(first.code, 'AUTH_FAILED');
  assert.ok(first.recovery.length > 0);
  let status = await manager.status(agent.id);
  assert.equal(status.state, 'failed');
  assert.equal(status.lastError.code, 'AUTH_FAILED');
  assert.ok(status.retryInMs > 0);
  assert.equal(config.agents[0].lastError.code, 'AUTH_FAILED');

  const timeout = mapConnectionError(Object.assign(new Error('request timed out'), {code: 'REQUEST_TIMEOUT'}));
  assert.equal(timeout.code, 'REQUEST_TIMEOUT');
  const negotiation = mapConnectionError(Object.assign(new Error('era negotiation failed'), {code: 'ERA_NEGOTIATION_FAILED'}));
  assert.equal(negotiation.code, 'ERA_NEGOTIATION_FAILED');
  const generic = mapConnectionError(new Error('spawn claude ENOENT'));
  assert.equal(generic.code, 'CONNECT_FAILED');
  const leaky = mapConnectionError(Object.assign(new Error('connect https://user:pass@dify.example.com/mcp?token=abc failed'), {code: 'CONNECT_FAILED'}));
  assert.doesNotMatch(leaky.message, /pass|token=abc/);
  assert.match(leaky.message, /https:\/\/dify\.example\.com\/mcp/);

  await manager.test(agent.id).catch(() => null);
  await manager.test(agent.id).catch(() => null);
  const exhausted = await manager.test(agent.id).then(() => null, error => error);
  assert.equal(exhausted.code, 'AUTH_FAILED');
  assert.equal(exhausted.exhausted, true, '3 次 / 10 分钟后要求手动重试');
  status = await manager.status(agent.id);
  assert.equal(status.retryExhausted, true);
});

test('重连：手动 reconnect 清掉退避并重新连接（不调用工具）', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({name: 'HTTP', transport: 'http', url: 'https://agent.example.com/mcp'}, {isOwner: true});
  const log = [];
  const options = {fail: Object.assign(new Error('boom'), {code: 'CONNECT_FAILED'})};
  const now = clock();
  const factory = fakeFactory(log, options);
  const manager = new AgentConnectionManager({home, config, createConnection: factory, now, timer: fakeTimer()});
  t.after(() => manager.closeAll());

  await manager.test(agent.id).catch(() => null);
  options.fail = null;
  const status = await manager.reconnect(agent.id);
  assert.equal(status.state, 'connected');
  assert.equal(status.lastError, null);
  assert.equal(log.filter(item => item.kind === 'callTool').length, 0);
});

test('stdio：子进程环境不继承 CAREER_* / 模型 Key / 代理，cwd 锁在用户目录，shell: false', async t => {
  const {home, config} = await setup(t);
  const agent = await config.create({
    name: 'Claude Code', transport: 'stdio', command: 'claude', args: ['mcp', 'serve'],
    env: {COZE_API_TOKEN: 'coze-secret', NORMAL: 'ok'}
  }, {isOwner: true});
  const env = safeStdioEnv({
    CAREER_MODEL_API_KEY: 'no', CAREER_DATA_DIR: 'no', HTTP_PROXY: 'http://proxy', ALL_PROXY: 'x',
    OPENAI_API_KEY: 'no', COZE_API_TOKEN: 'coze-secret', NORMAL: 'ok'
  });
  assert.deepEqual(env, {COZE_API_TOKEN: 'coze-secret', NORMAL: 'ok'});
  const spawn = stdioSpawnOptions({stdio: {command: 'claude', args: ['mcp', 'serve']}}, home, config.credentialsFor(agent.id));
  assert.equal(spawn.command, 'claude');
  assert.deepEqual(spawn.args, ['mcp', 'serve']);
  assert.equal(spawn.cwd, home);
  assert.equal(spawn.shell, false);
  assert.equal(spawn.env.COZE_API_TOKEN, 'coze-secret');
});

test('kill 路径：Windows 用 taskkill /T /F，POSIX 先进程组 SIGTERM 再 SIGKILL', async () => {
  const winCalls = [];
  const win = await killProcessTree({
    pid: 1234, platform: 'win32',
    run: async (command, args) => { winCalls.push([command, ...args]); return {code: 0}; }
  });
  assert.deepEqual(winCalls, [['taskkill', '/PID', '1234', '/T', '/F']]);
  assert.deepEqual(win, {killed: true, method: 'taskkill', code: 0});

  const signals = [];
  const posix = await killProcessTree({
    pid: 4321, platform: 'linux',
    kill: (target, signal) => { signals.push([target, signal]); },
    sleep: async () => {}
  });
  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
  assert.deepEqual(posix, {killed: true, method: 'process-group'});

  const fallback = [];
  await killProcessTree({
    pid: 99, platform: 'darwin',
    kill: (target, signal) => {
      if (target === -99) throw new Error('no group');
      fallback.push([target, signal]);
    },
    sleep: async () => {}
  });
  assert.deepEqual(fallback, [[99, 'SIGTERM'], [99, 'SIGKILL']]);
});
