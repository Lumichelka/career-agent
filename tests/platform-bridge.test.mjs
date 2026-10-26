import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(root, 'src', 'platform', 'mcp.mjs');

// 假的后端：桥用 CAREER_BRIDGE_URL + token 调这些接口；测试只关心桥有没有把请求带到。
async function startBackend({status = 200} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({url: req.url, token: req.headers['x-career-token'], body: JSON.parse(raw || '{}')});
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(status === 200 ? {status: 'readable', action: req.url.split('/').pop()} : {error: 'unauthorized'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {url, requests, close: () => new Promise(resolve => server.close(resolve))};
}

function bridgeTransport(backendUrl, extraEnv = {}) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    env: {...process.env, CAREER_BRIDGE_URL: backendUrl, CAREER_BRIDGE_TOKEN: 'bridge-test-token', CAREER_TASK_ID: 'task-1', ...extraEnv},
    stderr: 'pipe'
  });
}

// 先登记清理再连接：连接失败时也不会把假后端留在事件循环里。
async function connectClient(t, backend, mode) {
  t.after(async () => { await backend.close(); });
  const client = new Client({name: 'career-bridge-test', version: '1.0.0'}, {versionNegotiation: {mode}});
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(bridgeTransport(backend.url));
  return client;
}

for (const mode of ['legacy', 'auto']) {
  test('桥接接受 ' + mode + ' 客户端：初始化、ListTools、CallTool 都可用', async t => {
    const backend = await startBackend();
    const client = await connectClient(t, backend, mode);

    const era = client.getProtocolEra();
    assert.ok(era === 'legacy' || era === 'modern', '应协商出确定的时代，实际：' + era);
    if (mode === 'auto') assert.equal(era, 'modern', 'auto 应协商到 modern');
    if (mode === 'legacy') assert.equal(era, 'legacy');

    const {tools} = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.deepEqual(names, ['career_platform_status', 'career_platform_search', 'career_platform_read', 'career_platform_jobs', 'career_platform_jobs_save']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    const saveTool = tools.find(tool => tool.name === 'career_platform_jobs_save');
    assert.equal(saveTool.annotations?.readOnlyHint, false, '岗位入库不是只读工具');

    const result = await client.callTool({name: 'career_platform_status', arguments: {}});
    assert.ok(!result.isError, '成功调用不应标记 isError');
    assert.equal(result.content[0].type, 'text');
    assert.equal(JSON.parse(result.content[0].text).status, 'readable');

    const listed = await client.callTool({name: 'career_platform_jobs', arguments: {q: '数据'}});
    assert.equal(listed.isError, undefined);
    assert.equal(backend.requests.at(-1).url, '/api/platform/jobs');
    assert.equal(backend.requests.at(-1).body.q, '数据');

    const saved = await client.callTool({name: 'career_platform_jobs_save', arguments: {platform: 'boss', idempotencyKey: 'save-1'}});
    assert.equal(saved.isError, undefined);
    assert.equal(backend.requests.at(-1).url, '/api/platform/jobsSave');
    assert.equal(backend.requests.at(-1).body.platform, 'boss');

    assert.equal(backend.requests.length, 3);
    assert.equal(backend.requests[0].url, '/api/platform/status');
    assert.equal(backend.requests[0].token, 'bridge-test-token');
    assert.equal(backend.requests[0].body.taskId, 'task-1');
  });
}

test('后端 401：桥把失败作为 isError 结果返回，连接不断', async t => {
  const backend = await startBackend({status: 401});
  const client = await connectClient(t, backend, 'legacy');

  const result = await client.callTool({name: 'career_platform_read', arguments: {platform: 'boss'}});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unauthorized|error/i);

  const {tools} = await client.listTools();
  assert.equal(tools.length, 5, '失败一次后连接仍可用');
});

test('未知工具名：报错而不是转发到后端', async t => {
  const backend = await startBackend();
  const client = await connectClient(t, backend, 'legacy');
  await assert.rejects(() => client.callTool({name: 'career_platform_write', arguments: {}}), /未知工具/);
  assert.equal(backend.requests.length, 0);
});

test('缺桥接配置：进程直接退出并说明原因', async () => {
  const child = spawn(process.execPath, [BRIDGE], {env: {...process.env, CAREER_BRIDGE_URL: '', CAREER_BRIDGE_TOKEN: ''}, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /缺少本机平台桥接配置/);
});

test('Codex 启动参数仍挂内部任务桥（解析后断言，不锁书写格式）', async () => {
  const {codexBridgeArgs, attachCodexBridge} = await import('../src/agent/agent.mjs');
  const args = codexBridgeArgs(root);
  const pairs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const [key, ...rest] = args[i + 1].split('=');
    pairs[key] = rest.join('=');
    i++;
  }
  assert.equal(JSON.parse(pairs['mcp_servers.career_platform.command']), process.execPath);
  const script = JSON.parse(pairs['mcp_servers.career_platform.args'])[0];
  assert.match(script, /platform[\\/]mcp\.mjs$/, '应指向内部任务桥脚本');
  assert.deepEqual(JSON.parse(pairs['mcp_servers.career_platform.env_vars']), ['CAREER_BRIDGE_URL', 'CAREER_BRIDGE_TOKEN', 'CAREER_TASK_ID']);
  assert.equal(pairs['mcp_servers.career_platform.tool_timeout_sec'], '420');
  assert.deepEqual(JSON.parse(pairs['mcp_servers.career_platform.enabled_tools']), ['career_platform_status', 'career_platform_search', 'career_platform_read', 'career_platform_jobs', 'career_platform_jobs_save']);

  const bridgeUrl = 'http://127.0.0.1:1';
  assert.deepEqual(attachCodexBridge(['tail'], {root, search: true, bridgeUrl}).slice(-1), ['tail']);
  assert.ok(attachCodexBridge(['tail'], {root, search: true, bridgeUrl}).length > 1, '有条件时应挂桥');
  assert.deepEqual(attachCodexBridge(['tail'], {root, search: false, bridgeUrl}), ['tail'], 'search=false 时不挂桥');
  assert.deepEqual(attachCodexBridge(['tail'], {root, search: true, bridgeUrl: ''}), ['tail'], '没有桥地址时不挂桥');
});


// 不依赖 SDK 的 2025 时代客户端：手写 initialize + tools/list + tools/call，模拟 Codex 这类旧宿主。
async function startRawLegacyClient(backendUrl) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {...process.env, CAREER_BRIDGE_URL: backendUrl, CAREER_BRIDGE_TOKEN: 'bridge-test-token', CAREER_TASK_ID: 'task-raw'},
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  const queue = [], waiters = [];
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message); else queue.push(message);
    }
  });
  return {
    child,
    send: message => child.stdin.write(JSON.stringify(message) + '\n'),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))
  };
}

test('不依赖 SDK 的 2025 时代客户端（模拟 Codex）能完成初始化与一次调用', async t => {
  const backend = await startBackend();
  t.after(async () => { await backend.close(); });
  const raw = await startRawLegacyClient(backend.url);
  t.after(() => raw.child.kill());

  raw.send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'raw-legacy', version: '1.0.0'}}});
  const initialized = await raw.next();
  assert.equal(initialized.id, 1);
  assert.ok(initialized.result.protocolVersion, '应返回协商的协议版本');

  raw.send({jsonrpc: '2.0', method: 'notifications/initialized'});
  raw.send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
  const listed = await raw.next();
  assert.equal(listed.result.tools.length, 5);

  raw.send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'career_platform_status', arguments: {}}});
  const called = await raw.next();
  assert.equal(called.result.content[0].type, 'text');
  assert.equal(backend.requests.at(-1).url, '/api/platform/status');
});
