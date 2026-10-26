import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {runAgent} from '../src/agent/agent.mjs';
import {runApiModel} from '../src/model/api-model.mjs';
import {pickFallback, suggestFallback} from '../src/model/backends.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-fallback-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

// 用 node.exe 冒充 Codex：参数不合法会立刻退出，模拟「本机 Codex 不可用」的失败，不依赖机器上是否装了 Codex。
function fakeCodex(t) {
  const before = process.env.CAREER_CODEX_PATH;
  process.env.CAREER_CODEX_PATH = process.execPath;
  t.after(() => {
    if (before === undefined) delete process.env.CAREER_CODEX_PATH;
    else process.env.CAREER_CODEX_PATH = before;
  });
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function login(app, name, password) {
  const response = await fetch(app.origin + '/api/auth/login', {
    method: 'POST', headers: headers(app, ''), body: JSON.stringify({name, password})
  });
  assert.equal(response.status, 200, name + ' 登录失败');
  return {user: (await response.json()).user, cookie: cookieOf(response)};
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST', headers: headers(app, ''), body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  assert.equal(response.status, 200, name + ' 注册失败');
  return {user: (await response.json()).user, cookie: cookieOf(response)};
}

async function ownerLogin(app) {
  const text = await readFile(join(app.dataDir, '首次登录.txt'), 'utf8');
  const password = text.match(/密码：(.+)/)?.[1]?.trim();
  assert.ok(password, '首次登录.txt 里应有 owner 密码');
  return login(app, 'owner', password);
}

async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  return {status: response.status, body: await response.json()};
}

async function postJson(app, path, cookie, body, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 状态不符：' + JSON.stringify(payload));
  return payload;
}

async function saveModel(app, cookie, settings) {
  return postJson(app, '/api/model/save', cookie, {protocol: 'chat', stream: true, ...settings});
}

async function newSession(app, cookie) {
  return postJson(app, '/api/new', cookie, {});
}

async function collectEvents(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

async function chat(app, cookie, sessionId, message, extra = {}) {
  const response = await fetch(app.origin + '/api/chat', {
    method: 'POST', headers: headers(app, cookie),
    body: JSON.stringify({id: sessionId, message, ...extra})
  });
  assert.equal(response.status, 200, 'chat 应返回 NDJSON');
  return collectEvents(response);
}

function suggestionsOf(events) {
  return events.filter(event => event.type === 'fallback_suggested');
}

function lastTask(events) {
  return events.filter(event => event.type === 'task').at(-1);
}

// —— 选择规则（模块级） ——

test('回退候选：同能力、排除当前后端、本地 ¥0 最前、无价排后', () => {
  const entries = [
    {kind: 'api', label: 'API · 贵', capabilities: ['text', 'tools'], configured: true, preset: 'deepseek', model: 'deepseek-v4-pro', approxCostPerCall: 0.02, approxCostLabel: '≈¥0.02'},
    {kind: 'api', label: 'API · 视觉', capabilities: ['text', 'tools', 'vision'], configured: true, preset: 'deepseek', model: 'deepseek-flash', approxCostPerCall: 0.01, approxCostLabel: '≈¥0.01'},
    {kind: 'local', label: '本地模型 · qwen', capabilities: ['text', 'tools'], configured: true, preset: 'ollama', model: 'qwen2.5:7b', approxCostPerCall: 0, approxCostLabel: '≈¥0'},
    {kind: 'codex', label: '本机 Codex', capabilities: ['text', 'tools'], configured: true, preset: 'codex', model: '', approxCostPerCall: null, approxCostLabel: ''},
    {kind: 'agent', label: '外部 Agent', capabilities: ['text', 'tools'], configured: true, preset: '', model: '', approxCostPerCall: null, approxCostLabel: ''},
    {kind: 'api', label: 'API · 未配置', capabilities: ['text', 'tools'], configured: false, preset: 'zhipu', model: 'glm-4-flash', approxCostPerCall: 0, approxCostLabel: '≈¥0'}
  ];
  const text = pickFallback(entries, {capabilities: ['text', 'tools'], currentKind: 'api'});
  assert.equal(text.kind, 'local', '本机 ¥0 排最前');
  assert.equal(text.approxCostLabel, '≈¥0');

  const fromLocal = pickFallback(entries, {capabilities: ['text', 'tools'], currentKind: 'local'});
  assert.equal(fromLocal.kind, 'api');
  assert.equal(fromLocal.label, 'API · 视觉', '同价/低价在前，未配置的不参与');

  const vision = pickFallback(entries, {capabilities: ['text', 'tools', 'vision'], currentKind: 'local'});
  assert.equal(vision.model, 'deepseek-flash', '视觉任务只出视觉后端');
  assert.equal(pickFallback(entries, {capabilities: ['text', 'tools', 'vision'], currentKind: 'api'}), null, '没有其他视觉后端就不给建议');
});

test('回退建议门：锁定、有工具成功、建议满 3 次、连续失败超过 3 次都不给', () => {
  const settings = {mode: 'api', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: true};
  const user = {name: 'owner'};
  const base = {settings, user, capabilities: ['text', 'tools'], currentKind: 'api', depth: 0, streak: 1};
  const ok = suggestFallback(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.suggestion.kind, 'codex', 'owner 的已配置 Codex 是唯一候选');
  assert.equal(ok.suggestion.approxCostLabel, '', '无价的后端不编金额');
  assert.equal('taskId' in ok.suggestion, false, '绑定信息由任务记录补');

  assert.equal(suggestFallback({...base, locked: true}).ok, false);
  assert.equal(suggestFallback({...base, hadToolSuccess: true}).ok, false);
  assert.equal(suggestFallback({...base, depth: 3}).ok, false);
  assert.equal(suggestFallback({...base, streak: 4}).ok, false);
});

// —— 端到端（HTTP 应用工厂） ——

test('HTTP：失败无工具成功只给一条换后端建议，点击后整轮重跑成功并标 fallback', async t => {
  fakeCodex(t);
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const owner = await ownerLogin(app);
  await saveModel(app, owner.cookie, {preset: 'deepseek', mode: 'api', baseUrl: mock.url, model: 'deepseek-flash', apiKey: 'sk-test'});
  await postJson(app, '/api/backends/select', owner.cookie, {kind: 'codex'});
  const session = await newSession(app, owner.cookie);

  const failed = await chat(app, owner.cookie, session.id, '帮我整理这次双选会');
  const suggestions = suggestionsOf(failed);
  assert.equal(suggestions.length, 1, '一次失败只给一个建议');
  const suggestion = suggestions[0];
  assert.equal(suggestion.kind, 'api');
  assert.match(suggestion.label, /DeepSeek/);
  assert.match(suggestion.approxCostLabel, /^≈¥/);
  assert.equal(suggestion.preset, 'deepseek');
  assert.equal(suggestion.model, 'deepseek-flash');
  assert.ok(suggestion.taskId, '建议绑定失败的任务');
  assert.equal(lastTask(failed).state, 'failed');
  assert.ok(failed.some(event => event.type === 'error'));

  const tasks = (await getJson(app, '/api/tasks', owner.cookie)).body.tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].fallback.kind, 'api');
  assert.equal(tasks[0].fallback.taskId, tasks[0].id);
  assert.equal(tasks[0].fallback.message, '帮我整理这次双选会');
  assert.equal(tasks[0].fallback.consumedAt || '', '', '还没点击');

  // 绑定校验：别的任务/别的后端都不能用这条建议。
  await postJson(app, '/api/backends/fallback', owner.cookie, {taskId: tasks[0].id, kind: 'local'}, 409);
  const applied = await postJson(app, '/api/backends/fallback', owner.cookie, {taskId: tasks[0].id, kind: 'api'});
  assert.equal(applied.ok, true);
  assert.equal(applied.current.kind, 'api');
  assert.equal(applied.fallback.kind, 'api');
  assert.equal(applied.fallback.depth, 0);
  assert.equal((await getJson(app, '/api/backends', owner.cookie)).body.current.kind, 'api');
  await postJson(app, '/api/backends/fallback', owner.cookie, {taskId: tasks[0].id, kind: 'api'}, 409); // 一次点击只消费一次

  // 客户端点完重新提交同一消息：新的一轮成功，调用记录标 fallback。
  const retried = await chat(app, owner.cookie, session.id, '帮我整理这次双选会', {fallbackDepth: 1});
  assert.equal(retried.at(-1).type, 'done');
  const calls = retried.at(-1).session.messages.at(-1).calls;
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.outcome, 'fallback');
  const after = (await getJson(app, '/api/tasks', owner.cookie)).body.tasks;
  assert.equal(after.length, 2);
  assert.equal(after.find(task => task.id === tasks[0].id).fallback.consumedAt.length > 0, true);
});

test('HTTP：本轮已有工具成功后再失败，只报错，不给换后端建议', async t => {
  const mock = await startMockOpenAI();
  mock.state.failAfterTool = true;
  t.after(() => mock.close());
  const app = await startApp(t);
  const owner = await ownerLogin(app);
  await saveModel(app, owner.cookie, {preset: 'deepseek', mode: 'api', baseUrl: mock.url, model: 'deepseek-flash', apiKey: 'sk-test'});
  const session = await newSession(app, owner.cookie);

  const events = await chat(app, owner.cookie, session.id, '研究这个招聘项目');
  assert.equal(suggestionsOf(events).length, 0, '有工具副作用就不建议换后端');
  assert.equal(lastTask(events).state, 'failed');
  assert.ok(events.some(event => event.type === 'error'));
  // 工具确实执行成功过（招聘库被打开），并且当时有可建议的已配置 Codex。
  await access(join(app.dataDir, 'users', owner.user.id, '.data', 'recruit.db'));
  const view = (await getJson(app, '/api/backends', owner.cookie)).body;
  assert.ok(view.candidates.some(card => card.kind === 'codex' && card.configured), '本来有可建议的后端');
  const tasks = (await getJson(app, '/api/tasks', owner.cookie)).body.tasks;
  assert.equal(tasks[0].fallback, null);
});

test('HTTP：锁定时失败只报错，且永远不静默请求备用接口', async t => {
  const primary = await startMockOpenAI();
  const backup = await startMockOpenAI();
  t.after(async () => { await primary.close(); await backup.close(); });
  const app = await startApp(t);
  const owner = await ownerLogin(app);
  await saveModel(app, owner.cookie, {
    preset: 'deepseek', mode: 'api', baseUrl: primary.url, model: 'deepseek-flash', apiKey: 'sk-primary',
    fallback: {enabled: true, preset: 'deepseek', protocol: 'chat', baseUrl: backup.url, model: 'deepseek-flash', apiKey: 'sk-backup'}
  });
  primary.state.status = 401;
  const session = await newSession(app, owner.cookie);

  const locked = await chat(app, owner.cookie, session.id, '锁定这一轮', {lock: true});
  assert.equal(suggestionsOf(locked).length, 0, '锁定时不给换后端建议');
  assert.equal(lastTask(locked).state, 'failed');
  assert.ok(locked.some(event => event.type === 'error'));
  assert.equal(backup.state.requests.length, 0, '锁定时不能静默回退到备用接口');

  const unlocked = await chat(app, owner.cookie, session.id, '不锁这一轮');
  assert.equal(backup.state.requests.length, 0, '未锁定也不能静默回退；换后端必须点一次');
  assert.equal(suggestionsOf(unlocked).length, 1, '未锁定时给一条建议');
  assert.equal(lastTask(unlocked).state, 'failed');
});

test('HTTP：连续失败最多建议 3 次，之后只剩错误；fallbackDepth=3 不再建议', async t => {
  const primary = await startMockOpenAI();
  primary.state.status = 401;
  t.after(() => primary.close());
  const app = await startApp(t);
  const owner = await ownerLogin(app);
  await saveModel(app, owner.cookie, {preset: 'deepseek', mode: 'api', baseUrl: primary.url, model: 'deepseek-flash', apiKey: 'sk-primary'});
  // 建议次数按会话累计，两个场景各用一个会话，互不污染。
  const depthSession = await newSession(app, owner.cookie);
  const depthThree = await chat(app, owner.cookie, depthSession.id, '第二次换后端', {fallbackDepth: 3});
  assert.equal(suggestionsOf(depthThree).length, 0, '建议用满 3 次后不再建议');

  // 连续失败按服务端计数兜底：客户端不老实递增也封顶在 3 条建议。
  const streakSession = await newSession(app, owner.cookie);
  const states = [];
  for (let i = 0; i < 4; i += 1) states.push(suggestionsOf(await chat(app, owner.cookie, streakSession.id, '连续失败 ' + i)).length);
  assert.deepEqual(states, [1, 1, 1, 0], '前三次各一条，第四次不再建议');
});

test('agent 结果：报告本轮是否真有工具成功（error/blocked/confirm_required/duplicate 不算）', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const backend = {kind: 'api', preset: 'deepseek', model: 'deepseek-flash', label: 'API · DeepSeek / deepseek-flash'};
  const config = {protocol: 'chat', stream: true, baseUrl: mock.url, model: 'deepseek-flash', maxTokens: 512};
  const run = toolCaller => runAgent({
    root, session: {messages: [], memory: '', artifacts: []}, message: '研究这个招聘项目', backend,
    modelCall: options => runApiModel({...options, config, toolCaller})
  });

  const succeeded = await run(async () => ({status: 'readable', jobs: []}));
  assert.equal(succeeded.hadToolSuccess, true);
  assert.equal(succeeded.toolSuccesses, 1);

  for (const value of [{status: 'error', code: 'TOOL_FAILED'}, {status: 'blocked', code: 'DUPLICATE_CALL'}, {status: 'confirm_required'}, {status: 'ok', duplicate: true}]) {
    const result = await run(async () => value);
    assert.equal(result.hadToolSuccess, false, JSON.stringify(value));
    assert.equal(result.toolSuccesses, 0);
  }

  mock.state.failAfterTool = true;
  await assert.rejects(run(async () => ({status: 'readable'})), error => {
    assert.equal(error.hadToolSuccess, true, '失败也要把副作用带出来');
    assert.equal(error.toolSuccesses, 1);
    return true;
  });
});
