import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 假 transport：只记录 connect / listTools / callTool，绝不启动真实外部 Agent 或联网。
function fakeFactory(options = {}) {
  const log = [];
  const factory = async context => {
    factory.calls += 1;
    const index = factory.calls;
    log.push({kind: 'context', index, agent: context.agent.name});
    return {
      pid: null,
      era: () => 'modern',
      serverInfo: () => ({name: 'fake-mcp', version: '2.0.0'}),
      connect: async () => { log.push({kind: 'connect', index}); },
      listTools: async () => {
        log.push({kind: 'listTools', index});
        const tools = options.tools || [{
          name: 'echo', title: '回声', description: '把文本带回来',
          annotations: {readOnlyHint: true},
          inputSchema: {type: 'object', properties: {q: {type: 'string'}}}
        }];
        return {tools: tools.map(tool => ({...tool}))};
      },
      callTool: async (name, args, callOptions = {}) => {
        log.push({kind: 'callTool', index, name, args});
        callOptions.onprogress?.({progress: 1, total: 2});
        callOptions.onprogress?.({progress: 2, total: 2});
        if (options.callFail) throw options.callFail;
        return {content: [{type: 'text', text: '外部结果：' + name}]};
      },
      close: async () => { log.push({kind: 'close', index}); }
    };
  };
  factory.calls = 0;
  factory.log = log;
  return factory;
}

async function startApp(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ext-http-'));
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
async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const body = await response.json();
  assert.equal(response.status, 200, path + ' 失败：' + JSON.stringify(body));
  return body;
}
async function post(app, path, cookie, body) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}
async function postJson(app, path, cookie, body) {
  const out = await post(app, path, cookie, body);
  assert.equal(out.status, 200, path + ' 失败：' + JSON.stringify(out.body));
  return out.body;
}
async function saveModel(app, cookie, baseUrl) {
  return postJson(app, '/api/model/save', cookie, {mode: 'local', protocol: 'chat', baseUrl, model: 'mock-model', stream: true});
}
async function createAgent(app, cookie, body) {
  const out = await postJson(app, '/api/agents', cookie, body);
  return out.agent;
}
async function newSession(app, cookie) {
  return postJson(app, '/api/new', cookie, {});
}

async function streamChat(app, cookie, body, onEvent) {
  const response = await fetch(app.origin + '/api/chat', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  assert.equal(response.status, 200, '聊天请求失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (onEvent) await onEvent(event, events);
    }
  }
  return events;
}

test('HTTP：首次出网确认弹一次；等待时任务待确认；接受后本轮继续并调用外部工具', {timeout: 90000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const member = await register(app, 'ext-user');
  await saveModel(app, member.cookie, mock.url);
  const agent = await createAgent(app, member.cookie, {name: 'Dify 助手', transport: 'http', url: 'https://dify.example.com/mcp', token: 'sk-http-secret'});
  const session = await newSession(app, member.cookie);

  const confirmed = [];
  let taskId = '';
  const events = await streamChat(app, member.cookie, {id: session.id, message: '请调用外部工具'}, async event => {
    if (event.type === 'task' && event.taskId) taskId = event.taskId;
    if (event.type !== 'external_confirm_required') return;
    confirmed.push(event);
    // 等待期间任务卡必须是待确认，徽标计数包含它。
    let state = '';
    for (let i = 0; i < 150; i += 1) {
      const list = await getJson(app, '/api/tasks', member.cookie);
      const task = list.tasks.find(item => item.id === event.taskId);
      if (task) {
        state = task.state;
        if (state === 'waiting_confirmation') { assert.ok(list.badge >= 1, '待确认计入顶栏徽标'); break; }
      }
      await wait(20);
    }
    assert.equal(state, 'waiting_confirmation');
    const answer = await postJson(app, '/api/agents/outbound', member.cookie, {confirmId: event.confirmId, decision: 'always'});
    assert.equal(answer.decision, 'always');
  });

  assert.equal(confirmed.length, 1, '首次调用只弹一次确认');
  assert.equal(confirmed[0].agentName, 'Dify 助手');
  assert.match(confirmed[0].message, /看到|副作用/);
  assert.deepEqual(confirmed[0].options.map(option => option.value), ['once', 'always', 'reject']);
  assert.ok(events.some(event => event.type === 'external_confirm_resolved' && event.decision === 'always'));
  assert.ok(events.some(event => event.type === 'tool_progress' && event.progress === 1 && event.tool.startsWith('mcp__')), '有 tool_progress');
  assert.ok(events.some(event => event.type === 'tool' && /外部 Agent/.test(event.text)));
  assert.ok(events.some(event => event.type === 'evidence' && event.evidence.kind === 'external_call' && /只读/.test(event.evidence.label)));
  assert.ok(events.some(event => event.type === 'done'));
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 1, '接受后真正调用一次');
  assert.equal(factory.log.find(item => item.kind === 'callTool').args.q, undefined);

  // 「以后不再问」写进该用户 Agent 配置。
  const raw = JSON.parse(await readFile(join(app.dataDir, 'users', member.user.id, '.data', 'agents.json'), 'utf8'));
  assert.equal(raw.agents.find(item => item.id === agent.id).outbound.neverAsk, true);

  // 完整响应写进该任务证据目录。
  const files = await readdir(join(app.dataDir, 'users', member.user.id, 'tasks', taskId, 'evidence'));
  assert.ok(files.some(name => name.startsWith('mcp-')), '证据文件落盘');

  // 第二个任务不再弹确认，直接调用。
  const second = await newSession(app, member.cookie);
  const secondEvents = await streamChat(app, member.cookie, {id: second.id, message: '请调用外部工具'});
  assert.equal(secondEvents.some(event => event.type === 'external_confirm_required'), false, '已选以后不再问');
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 2);
});

test('HTTP：拒绝出网确认后不发送内容，本轮继续但记为取消且下次仍会问', {timeout: 90000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const member = await register(app, 'ext-reject');
  await saveModel(app, member.cookie, mock.url);
  const agent = await createAgent(app, member.cookie, {name: '拒答助手', transport: 'http', url: 'https://reject.example.com/mcp'});
  const session = await newSession(app, member.cookie);

  const confirmed = [];
  const events = await streamChat(app, member.cookie, {id: session.id, message: '请调用外部工具'}, async event => {
    if (event.type !== 'external_confirm_required') return;
    confirmed.push(event);
    await postJson(app, '/api/agents/outbound', member.cookie, {confirmId: event.confirmId, decision: 'reject'});
  });
  assert.equal(confirmed.length, 1);
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 0, '拒绝后绝不把内容发给上游');
  assert.ok(events.some(event => event.type === 'external_confirm_resolved' && event.decision === 'reject'));
  assert.ok(events.some(event => event.type === 'evidence' && /CANCELLED/.test(event.evidence.detail)));
  assert.ok(events.some(event => event.type === 'done'), '拒绝一次外部调用不拖垮整个任务');
  const raw = JSON.parse(await readFile(join(app.dataDir, 'users', member.user.id, '.data', 'agents.json'), 'utf8'));
  assert.notEqual(raw.agents.find(item => item.id === agent.id).outbound?.neverAsk, true, '拒绝不落「以后不再问」');

  // 下一次任务仍然会问。
  const second = await newSession(app, member.cookie);
  let asked = 0;
  await streamChat(app, member.cookie, {id: second.id, message: '请调用外部工具'}, async event => {
    if (event.type !== 'external_confirm_required') return;
    asked += 1;
    await postJson(app, '/api/agents/outbound', member.cookie, {confirmId: event.confirmId, decision: 'reject'});
  });
  assert.equal(asked, 1, '拒绝不是持久选择，下次还要问');
});

test('HTTP：本地工具照旧直接执行，不弹首次出网确认', {timeout: 90000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const factory = fakeFactory();
  const app = await startApp(t, {agentClientFactory: factory});
  const member = await register(app, 'ext-local');
  await saveModel(app, member.cookie, mock.url);
  await createAgent(app, member.cookie, {name: 'Dify 助手', transport: 'http', url: 'https://dify.example.com/mcp'});
  const session = await newSession(app, member.cookie);
  const events = await streamChat(app, member.cookie, {id: session.id, message: '请调用 career_platform_status'});
  assert.equal(events.some(event => event.type === 'external_confirm_required'), false, '本地工具不弹确认');
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 0, '本地工具不走上游');
  assert.ok(events.some(event => event.type === 'done'));
});

test('HTTP：出网确认接口对未知 confirmId 返回 404，关闭服务时挂起确认按拒绝收尾', async t => {
  const app = await startApp(t);
  const member = await register(app, 'ext-api');
  const missing = await post(app, '/api/agents/outbound', member.cookie, {confirmId: '00000000-0000-7000-8000-000000000000', decision: 'always'});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CONFIRM_NOT_PENDING');
});

test('HTTP：对话页带出网确认弹窗与接口接线，本地工具不弹确认', async t => {
  const app = await startApp(t);
  const html = await (await fetch(app.origin + '/chat')).text();
  assert.match(html, /external-gate/);
  assert.match(html, /external_confirm_required/);
  assert.match(html, /agents\/outbound/);
  assert.match(html, /以后不再问/);
});
