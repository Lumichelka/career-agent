import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// 1×1 透明 PNG：只验证请求形状与能力判定，不依赖真实图片。
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const imageAttachment = () => ({name: '双选会截图.png', type: 'image', mime: 'image/png', dataUrl: PNG});

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-backends-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
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

test('HTTP：截图遇到无视觉的 Codex 停下出候选卡，选视觉 API 后本轮成功，调用表只挂助手消息', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const owner = await ownerLogin(app);
  await saveModel(app, owner.cookie, {preset: 'deepseek', mode: 'api', baseUrl: mock.url, model: 'deepseek-flash', apiKey: 'sk-test'});

  const view = (await getJson(app, '/api/backends', owner.cookie)).body;
  assert.equal(view.current.kind, 'api');
  assert.ok(view.capabilities.includes('vision'));
  assert.ok(view.candidates.some(card => card.kind === 'api' && card.configured));
  assert.ok(view.candidates.every(card => card.approxCostLabel === '' || card.approxCostLabel.startsWith('≈¥')));

  // 换成无视觉的本机 Codex（owner 才允许），带图任务就会停下来。
  await postJson(app, '/api/backends/select', owner.cookie, {kind: 'codex'});
  const session = await newSession(app, owner.cookie);
  const blocked = await chat(app, owner.cookie, session.id, '看看这张双选会截图，帮我整理活动', {attachments: [imageAttachment()]});
  const candidate = blocked.find(event => event.type === 'candidate_required');
  assert.ok(candidate, '应出现候选卡事件');
  assert.deepEqual(candidate.capabilities, ['text', 'tools', 'vision']);
  assert.equal(candidate.current.kind, 'codex');
  assert.ok(candidate.candidates.some(card => card.kind === 'api' && card.configured && card.capabilities.includes('vision')));
  const error = blocked.find(event => event.type === 'error');
  assert.equal(error.code, 'CANDIDATE_REQUIRED');
  assert.match(error.text, /视觉|候选/);
  const untouched = (await getJson(app, '/api/session/' + session.id, owner.cookie)).body;
  assert.equal(untouched.messages.length, 0, '停下来这一轮不写会话');
  assert.equal((await getJson(app, '/api/tasks', owner.cookie)).body.tasks.length, 0, '停下来这一轮不建任务记录');

  // 点候选卡：设为当前选择后重发本轮。
  const selected = await postJson(app, '/api/backends/select', owner.cookie, {kind: 'api'});
  assert.equal(selected.current.kind, 'api');
  const events = await chat(app, owner.cookie, session.id, '看看这张双选会截图，帮我整理活动', {attachments: [imageAttachment()]});
  assert.equal(events.at(-1).type, 'done');
  const saved = events.at(-1).session;
  const assistant = saved.messages.at(-1);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.calls.length, 3, '规划/执行/复核各一条');
  assert.deepEqual(assistant.calls.map(call => call.step), ['plan', 'act', 'review']);
  assert.equal(assistant.calls[0].backend.kind, 'api');
  assert.equal(assistant.calls[0].backend.preset, 'deepseek');
  assert.equal(assistant.calls[0].backend.model, 'deepseek-flash');
  assert.match(assistant.calls[0].backend.label, /DeepSeek/);
  for (const call of assistant.calls) {
    assert.ok(call.usage.input > 0 && call.usage.output > 0, 'usage 要回传');
    assert.equal(call.cost.estimated, true);
    assert.ok(call.cost.cny >= 0);
    assert.ok(call.durationMs >= 0);
  }
  // 用户消息里的图片不落 dataUrl（不把 8MB base64 写进会话 JSON）。
  const userMessage = saved.messages.at(-2);
  assert.equal(userMessage.attachments[0].type, 'image');
  assert.equal('dataUrl' in userMessage.attachments[0], false);

  // 图片只交给执行阶段一次；规划与复核不带图。
  const imageRequests = mock.state.requests.filter(body => (body.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
  assert.equal(imageRequests.length, 1, '只有 act 阶段请求带图片');
  assert.equal(imageRequests[0].messages.find(message => Array.isArray(message.content)).content.find(part => part.type === 'image_url').image_url.url, PNG);

  // 工作台任务记录没有调用明细。
  const tasks = (await getJson(app, '/api/tasks', owner.cookie)).body;
  assert.equal(tasks.tasks.length, 1);
  const taskJson = JSON.stringify(tasks.tasks[0]);
  assert.equal('calls' in tasks.tasks[0], false);
  assert.ok(!/\"usage\"|\"cost\"|未回传/.test(taskJson), '任务记录不能复制调用明细');

  // 下一轮仍沿用持久选择；per-turn backend 覆盖不改变持久选择。
  await postJson(app, '/api/backends/select', owner.cookie, {kind: 'codex'});
  const overridden = await chat(app, owner.cookie, session.id, '这一轮指定 API 后端', {backend: 'api'});
  assert.equal(overridden.at(-1).type, 'done');
  assert.equal((await getJson(app, '/api/backends', owner.cookie)).body.current.kind, 'codex');
  const overrideCalls = overridden.at(-1).session.messages.at(-1).calls;
  assert.equal(overrideCalls[0].backend.kind, 'api');
});

test('HTTP：锁定时失败不回退到备用接口，也不给换后端建议', async t => {
  const primary = await startMockOpenAI();
  const backup = await startMockOpenAI();
  t.after(async () => { await primary.close(); await backup.close(); });
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, {
    preset: 'deepseek', mode: 'api', baseUrl: primary.url, model: 'deepseek-flash', apiKey: 'sk-primary',
    fallback: {enabled: true, preset: 'deepseek', protocol: 'chat', baseUrl: backup.url, model: 'deepseek-flash', apiKey: 'sk-backup'}
  });
  primary.state.status = 401; // 鉴权失败同样属于可回退错误；不触发 429/5xx 的自动退避，测试更快。
  const session = await newSession(app, alice.cookie);

  const locked = await chat(app, alice.cookie, session.id, '锁定这一轮', {lock: true});
  assert.ok(!locked.some(event => event.type === 'fallback_suggested'), '锁定后不给换后端建议');
  assert.equal(locked.filter(event => event.type === 'task').at(-1).state, 'failed');
  assert.ok(locked.some(event => event.type === 'error'));
  assert.equal(backup.state.requests.length, 0, '锁定时不能静默回退到备用接口');

  // 不锁定时保留现有传输级备用链路，但 #33 的「换 X 重试」建议还没实现。
  const unlocked = await chat(app, alice.cookie, session.id, '不锁这一轮');
  assert.equal(unlocked.at(-1).type, 'done');
  assert.ok(backup.state.requests.length > 0, '未锁定时现有备用接口仍可用');
  assert.ok(!unlocked.some(event => event.type === 'fallback_suggested'));
});

test('HTTP：供应商没回 usage 显示「未回传」，未知价只留 tokens', async t => {
  const mock = await startMockOpenAI({usage: 'none'});
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'bob');
  await saveModel(app, alice.cookie, {preset: 'moonshot', mode: 'api', baseUrl: mock.url, model: 'kimi-k3.1-pro', apiKey: 'sk-test'});
  const session = await newSession(app, alice.cookie);
  const events = await chat(app, alice.cookie, session.id, '你好');
  const assistant = events.at(-1).session.messages.at(-1);
  assert.equal(assistant.calls.length, 3);
  for (const call of assistant.calls) {
    assert.equal('usage' in call, false, '没回 usage 不能编');
    assert.equal('cost' in call, false);
  }
  const tasks = (await getJson(app, '/api/tasks', alice.cookie)).body;
  assert.ok(!/\"usage\"|\"cost\"/.test(JSON.stringify(tasks.tasks)), '任务记录没有调用明细');
});

test('HTTP：价表没这个型号时只有 tokens，没有金额', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'carol');
  await saveModel(app, alice.cookie, {preset: 'moonshot', mode: 'api', baseUrl: mock.url, model: 'kimi-k3.1-pro', apiKey: 'sk-test'});
  const session = await newSession(app, alice.cookie);
  const events = await chat(app, alice.cookie, session.id, '你好');
  const assistant = events.at(-1).session.messages.at(-1);
  for (const call of assistant.calls) {
    assert.ok(call.usage.input > 0);
    assert.equal('cost' in call, false, '价表没型号不能显示金额');
  }
});
