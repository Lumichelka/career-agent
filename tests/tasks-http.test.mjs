import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startApp(t, taskLimits) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-tasks-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, taskLimits});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  const set = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean);
  return set.map(value => value.split(';')[0]).join('; ');
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  assert.equal(response.status, 200, name + ' 注册失败');
  return {user: (await response.json()).user, cookie: cookieOf(response)};
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const body = await response.json();
  assert.equal(response.status, 200, path + ' 失败：' + JSON.stringify(body));
  return body;
}

async function postJson(app, path, cookie, body, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 状态不符：' + JSON.stringify(payload));
  return payload;
}

async function newSession(app, cookie) {
  return postJson(app, '/api/new', cookie, {});
}

async function saveModel(app, cookie, baseUrl) {
  return postJson(app, '/api/model/save', cookie, {mode: 'local', protocol: 'chat', baseUrl, model: 'mock-model', stream: true});
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

async function chat(app, cookie, sessionId, message) {
  return fetch(app.origin + '/api/chat', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify({id: sessionId, message})});
}

async function waitFor(check, {timeoutMs = 15000, intervalMs = 25} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await wait(intervalMs);
  }
  throw new Error('等待条件超时');
}

test('HTTP：聊天任务输出 task 事件，抽屉接口能读到成功记录且跨用户隔离', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);
  const session = await newSession(app, alice.cookie);

  const response = await chat(app, alice.cookie, session.id, '帮我整理一次来源校对');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = await collectEvents(response);

  const taskEvents = events.filter(event => event.type === 'task');
  assert.deepEqual(taskEvents.map(event => event.state), ['queued', 'running', 'succeeded'], '任务卡状态要与事件一一对应');
  assert.match(taskEvents[0].taskId, /^[a-f0-9-]{36}$/);
  assert.notEqual(taskEvents[0].taskId, session.id, '任务 id 不等于会话 id');
  for (const event of taskEvents) {
    assert.equal(typeof event.phase, 'string');
    assert.ok(event.counts && typeof event.counts === 'object');
  }
  assert.ok(events.some(event => event.type === 'status'), '现有 status 事件不能丢');
  assert.ok(events.some(event => event.type === 'plan'), '现有 plan 事件不能丢');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).session.messages.at(-1).role, 'assistant');

  const listed = await getJson(app, '/api/tasks', alice.cookie);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].id, taskEvents[0].taskId);
  assert.equal(listed.tasks[0].state, 'succeeded');
  assert.equal(listed.tasks[0].sourceName, '对话');
  assert.equal(listed.badge, 0);

  const filtered = await getJson(app, '/api/tasks?session=' + session.id, alice.cookie);
  assert.equal(filtered.tasks.length, 1);
  const otherSession = await getJson(app, '/api/tasks?session=00000000-0000-0000-0000-000000000000', alice.cookie);
  assert.equal(otherSession.tasks.length, 0);

  const bob = await register(app, 'bob');
  const bobTasks = await getJson(app, '/api/tasks', bob.cookie);
  assert.equal(bobTasks.tasks.length, 0, '另一个账号看不到 alice 的任务');
});

test('HTTP：第 2 个任务排队，排队超时给 QUEUE_TIMEOUT；停止运行中任务进入 cancelled', async t => {
  // 故意把首个任务拖长：只要不停止它就一直处于 running，轮询在重负载下也一定能看到。
  const mock = await startMockOpenAI({delayMs: 5000});
  t.after(() => mock.close());
  const app = await startApp(t, {perUser: 1, global: 8, queueTimeoutMs: 150});
  const user = await register(app, 'carol');
  await saveModel(app, user.cookie, mock.url);
  const first = await newSession(app, user.cookie);
  const second = await newSession(app, user.cookie);

  const firstRun = chat(app, user.cookie, first.id, '第一个长任务').then(async response => ({response, events: await collectEvents(response)}));
  await waitFor(async () => (await getJson(app, '/api/tasks', user.cookie)).tasks.some(task => task.state === 'running'), {timeoutMs: 20000});
  const running = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(running.badge, 1, '运行中计入徽标');
  assert.equal(running.counts.running, 1);

  const secondResponse = await chat(app, user.cookie, second.id, '第二个任务应排队');
  const secondEvents = await collectEvents(secondResponse);
  assert.deepEqual(secondEvents.filter(event => event.type === 'task').map(event => event.state), ['queued', 'failed']);
  const queueError = secondEvents.find(event => event.type === 'error');
  assert.equal(queueError.code, 'QUEUE_TIMEOUT');
  assert.match(queueError.text, /排队/);

  const afterQueue = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(afterQueue.counts.failed, 1);
  assert.equal(afterQueue.badge, 1, '排队失败的任务不进徽标');
  assert.equal(afterQueue.tasks.find(task => task.state === 'failed').error.code, 'QUEUE_TIMEOUT');

  const firstTask = afterQueue.tasks.find(task => task.state === 'running');
  const stopped = await postJson(app, '/api/tasks/stop', user.cookie, {taskId: firstTask.id});
  assert.equal(stopped.ok, true);
  const firstResult = await firstRun;
  assert.equal(firstResult.events.filter(event => event.type === 'task').at(-1).state, 'cancelled');

  const final = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(final.badge, 0);
  assert.equal(final.counts.cancelled, 1);
  assert.equal((await postJson(app, '/api/tasks/stop', user.cookie, {taskId: firstTask.id}, 409)).error, '任务已结束');
});

test('HTTP：任务卡草稿保存/丢弃走接口，记录落盘', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const user = await register(app, 'dave');
  await saveModel(app, user.cookie, mock.url);
  const session = await newSession(app, user.cookie);

  const response = await chat(app, user.cookie, session.id, '请生成草稿：整理双选会活动');
  const events = await collectEvents(response);
  assert.equal(events.filter(event => event.type === 'task').at(-1).state, 'succeeded');

  const listed = await getJson(app, '/api/tasks', user.cookie);
  const task = listed.tasks[0];
  assert.equal(task.drafts.length, 1, '执行产出的文稿要挂到任务卡草稿区');
  assert.equal(task.drafts[0].title, '双选会草稿');
  assert.equal(task.drafts[0].status, 'draft');
  assert.equal(task.counts.drafts, 1);

  const discarded = await postJson(app, '/api/tasks/draft', user.cookie, {taskId: task.id, draftId: task.drafts[0].id, action: 'discard'});
  assert.equal(discarded.ok, true);
  assert.equal(discarded.task.drafts[0].status, 'discarded');
  const after = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(after.tasks[0].drafts[0].status, 'discarded');

  const badAction = await postJson(app, '/api/tasks/draft', user.cookie, {taskId: task.id, draftId: task.drafts[0].id, action: 'explode'}, 400);
  assert.match(badAction.error, /草稿动作/);
  const missing = await postJson(app, '/api/tasks/draft', user.cookie, {taskId: '11111111-1111-1111-1111-111111111111', draftId: 'x', action: 'save'}, 404);
  assert.match(missing.error, /草稿/);
});

test('HTTP：同一对话仍在执行时 /api/chat 保留 409', async t => {
  const mock = await startMockOpenAI({delayMs: 5000});
  t.after(() => mock.close());
  const app = await startApp(t);
  const user = await register(app, 'erin');
  await saveModel(app, user.cookie, mock.url);
  const session = await newSession(app, user.cookie);

  const first = chat(app, user.cookie, session.id, '第一个任务').then(async response => ({response, events: await collectEvents(response)}));
  await waitFor(async () => (await getJson(app, '/api/tasks', user.cookie)).counts.running === 1);
  const conflict = await chat(app, user.cookie, session.id, '同一对话再来一次');
  assert.equal(conflict.status, 409);

  const tasks = await getJson(app, '/api/tasks', user.cookie);
  await postJson(app, '/api/tasks/stop', user.cookie, {taskId: tasks.tasks[0].id});
  await first;
});
