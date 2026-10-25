import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function startApp(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-tasks-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, limits});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); });
  return app;
}

async function register(app, name = 'alice') {
  const res = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  assert.equal(res.status, 200, '注册应成功');
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).join('; ');
  return cookie;
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function setMockModel(app, cookie, mock) {
  const res = await fetch(app.origin + '/api/model/save', {
    method: 'POST',
    headers: headers(app, cookie),
    body: JSON.stringify({mode: 'api', protocol: 'chat', baseUrl: mock.url, model: 'mock-model', apiKey: '', preset: 'custom', maxTokens: 2048})
  });
  assert.equal(res.status, 200, await res.text());
}

async function newSession(app, cookie) {
  const res = await fetch(app.origin + '/api/new', {method: 'POST', headers: headers(app, cookie), body: '{}'});
  assert.equal(res.status, 200);
  return res.json();
}

async function apiJson(app, cookie, path, body) {
  const res = await fetch(app.origin + path, {
    method: body ? 'POST' : 'GET',
    headers: headers(app, cookie),
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  return {status: res.status, body: await res.json()};
}

// 一直读到响应结束的 NDJSON 收集器；用轮询等待某个事件，避免把流读死。
function feed(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = {events: [], done: false, error: null};
  state.pump = (async () => {
    let buffer = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          state.events.push(JSON.parse(line));
        }
      }
    } catch (error) {
      state.error = error;
    }
    state.done = true;
  })();
  return state;
}

async function waitFor(predicate, timeoutMs = 10000, label = '事件') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待' + label + '超时');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

function chat(app, cookie, sessionId, message) {
  const controller = new AbortController();
  const promise = fetch(app.origin + '/api/chat', {
    method: 'POST',
    headers: headers(app, cookie),
    body: JSON.stringify({id: sessionId, message}),
    signal: controller.signal
  });
  return {controller, promise};
}

test('对话任务：queued → running → succeeded 与事件一一对应，任务卡带进度', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const session = await newSession(app, cookie);

  const {promise} = chat(app, cookie, session.id, '你好');
  const stream = feed(await promise);
  await stream.pump;

  const states = stream.events.filter(event => event.type === 'task_state').map(event => event.state);
  assert.deepEqual(states, ['queued', 'running', 'succeeded'], '状态迁移必须按队列顺序出现');
  assert.ok(stream.events.some(event => event.type === 'done'), '应发 done 事件');

  const list = await apiJson(app, cookie, '/api/tasks');
  assert.equal(list.status, 200);
  assert.equal(list.body.tasks.length, 1);
  assert.equal(list.body.queue.active, 0, '任务结束后名额应释放');
  const card = list.body.tasks[0];
  assert.equal(card.state, 'succeeded');
  assert.equal(card.sessionId, session.id);
  assert.equal(card.progress.percent, 100);
  assert.ok(card.startedAt && card.finishedAt, '应有开始与结束时间');
  assert.ok(card.durationMs >= 0);

  const filtered = await apiJson(app, cookie, '/api/tasks?session=' + session.id);
  assert.equal(filtered.body.tasks.length, 1);
  const other = await apiJson(app, cookie, '/api/tasks?session=00000000-0000-0000-0000-000000000000');
  assert.equal(other.body.tasks.length, 0);

  const full = await apiJson(app, cookie, '/api/tasks/' + card.id);
  assert.equal(full.status, 200);
  const recorded = full.body.task.events.map(event => event.type);
  assert.ok(recorded.includes('task_state'), '完整任务应带事件历史');
  assert.ok(full.body.task.eventCount >= 3);
});

test('工具证据与文稿草稿落进同一张任务卡', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const session = await newSession(app, cookie);

  const {promise} = chat(app, cookie, session.id, '研究这个招聘项目，并整理成草稿。');
  const stream = feed(await promise);
  await stream.pump;

  assert.ok(stream.events.some(event => event.type === 'evidence'), '工具结果应发 evidence 事件');
  assert.ok(stream.events.some(event => event.type === 'draft'), '文稿应发 draft 事件');

  const card = (await apiJson(app, cookie, '/api/tasks')).body.tasks[0];
  assert.equal(card.state, 'succeeded');
  assert.ok(card.evidence.length >= 1, '任务卡应有证据');
  assert.ok(card.evidence[0].name, '证据要有名字');
  assert.ok(card.draft && card.draft.title, '任务卡应有草稿');
  assert.ok(card.draft.chars > 0);

  const stored = await apiJson(app, cookie, '/api/session/' + session.id);
  assert.ok(stored.body.artifacts.some(artifact => artifact.id === card.draft.artifactId), '草稿要指向真实文稿');
});

test('同一用户第 3 个任务排队；排队超时给出明确提示', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t, {userTaskLimit: 2, globalTaskLimit: 8, queueTimeoutMs: 150, taskTimeLimitMs: 60000});
  mock.state.delayMs = 1500;
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const sessions = [await newSession(app, cookie), await newSession(app, cookie), await newSession(app, cookie)];

  const first = chat(app, cookie, sessions[0].id, '第一条');
  const firstStream = feed(await first.promise);
  const second = chat(app, cookie, sessions[1].id, '第二条');
  const secondStream = feed(await second.promise);
  await waitFor(() => firstStream.events.some(event => event.type === 'task_state' && event.state === 'running'), 5000, '第一个任务开始');
  await waitFor(() => secondStream.events.some(event => event.type === 'task_state' && event.state === 'running'), 5000, '第二个任务开始');

  const third = chat(app, cookie, sessions[2].id, '第三条');
  const thirdStream = feed(await third.promise);
  await waitFor(() => thirdStream.events.some(event => event.type === 'error'), 5000, '排队超时提示');
  const error = thirdStream.events.find(event => event.type === 'error');
  assert.equal(error.code, 'QUEUE_TIMEOUT');
  assert.match(error.text, /排队/);
  await thirdStream.pump;

  const tasks = (await apiJson(app, cookie, '/api/tasks')).body.tasks;
  const queued = tasks.find(task => task.sessionId === sessions[2].id);
  assert.equal(queued.state, 'failed');
  assert.equal(queued.error.code, 'QUEUE_TIMEOUT');
  assert.equal(tasks.filter(task => task.state === 'running').length, 2, '前两个任务应仍在运行');

  first.controller.abort();
  second.controller.abort();
  await Promise.all([firstStream.pump, secondStream.pump]);
});

test('任务到时间上限停止，并把原因写进任务卡', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t, {taskTimeLimitMs: 150});
  mock.state.delayMs = 3000;
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const session = await newSession(app, cookie);

  const {promise} = chat(app, cookie, session.id, '这件事会超时');
  const stream = feed(await promise);
  await waitFor(() => stream.events.some(event => event.type === 'error'), 8000, '超时错误');
  await stream.pump;

  const error = stream.events.find(event => event.type === 'error');
  assert.equal(error.code, 'TASK_TIMEOUT');
  assert.match(error.text, /上限/);

  const card = (await apiJson(app, cookie, '/api/tasks')).body.tasks[0];
  assert.equal(card.state, 'failed');
  assert.equal(card.stopReason, 'time_limit');
  assert.equal(card.error.code, 'TASK_TIMEOUT');
});

test('停止运行中的任务：状态 cancelled，原因 user；已结束的任务再停返回 409', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t, {taskTimeLimitMs: 60000});
  mock.state.delayMs = 1500;
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const session = await newSession(app, cookie);

  const {promise} = chat(app, cookie, session.id, '这条会被停止');
  const stream = feed(await promise);
  await waitFor(() => stream.events.some(event => event.type === 'task_state' && event.state === 'running'), 5000, '任务开始');
  const card = (await apiJson(app, cookie, '/api/tasks')).body.tasks[0];

  const cancelled = await apiJson(app, cookie, '/api/tasks/cancel', {id: card.id});
  assert.equal(cancelled.status, 200);
  await waitFor(() => stream.events.some(event => event.type === 'error'), 5000, '停止事件');
  await stream.pump;

  const after = (await apiJson(app, cookie, '/api/tasks')).body.tasks.find(task => task.id === card.id);
  assert.equal(after.state, 'cancelled');
  assert.equal(after.stopReason, 'user');

  const again = await apiJson(app, cookie, '/api/tasks/cancel', {id: card.id});
  assert.equal(again.status, 409);
});

test('同一对话并发发起任务返回 409；未知任务返回 404', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  mock.state.delayMs = 1500;
  const cookie = await register(app);
  await setMockModel(app, cookie, mock);
  const session = await newSession(app, cookie);

  const first = chat(app, cookie, session.id, '第一条');
  const stream = feed(await first.promise);
  await waitFor(() => stream.events.some(event => event.type === 'task_state'), 5000, '任务创建');
  const duplicate = await fetch(app.origin + '/api/chat', {
    method: 'POST', headers: headers(app, cookie), body: JSON.stringify({id: session.id, message: '第二条'})
  });
  assert.equal(duplicate.status, 409);

  const missing = await apiJson(app, cookie, '/api/tasks/cancel', {id: '00000000-0000-0000-0000-000000000000'});
  assert.equal(missing.status, 404);

  first.controller.abort();
  await stream.pump;
});
