import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {ensureAuditSchema} from '../src/writes/audit-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-write-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function dbPath(app, user) {
  return join(app.dataDir, 'users', user.id, '.data', 'recruit.db');
}

// 每次读库都开一条短连接并立即关闭，避免 Windows 上测试结束删除临时目录时被 WAL 句柄占住。
function withStore(app, user, fn) {
  const store = RecruitStore.open(dbPath(app, user));
  try { return fn(store); } finally { store.close(); }
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) c FROM ' + table).get().c;
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
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

async function getJson(app, path, cookie, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const body = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 失败：' + JSON.stringify(body));
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
  const response = await fetch(app.origin + '/api/chat', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify({id: sessionId, message})});
  assert.equal(response.status, 200);
  return {response, events: await collectEvents(response)};
}

function toolResults(mock) {
  return mock.state.requests
    .flatMap(body => (body.messages || []).filter(message => message.role === 'tool').map(message => String(message.content)));
}

test('HTTP：任务批量写入 events / event_projects，审计 1:1 共享 batch_id；幂等重放不新增；任务卡计数', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);
  const session = await newSession(app, alice.cookie);

  const first = await chat(app, alice.cookie, session.id, '请自动写入招聘活动');
  const taskEvent = first.events.filter(event => event.type === 'task').at(-1);
  assert.equal(taskEvent.state, 'succeeded');
  const writes = first.events.filter(event => event.type === 'writes');
  assert.equal(writes.length, 1, '一次批量写发一个 writes 事件');
  assert.match(writes[0].batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(writes[0].counts, {rows: 2, created: 2, updated: 0, deleted: 0, skipped: 0});
  assert.equal(writes[0].taskId, taskEvent.taskId, 'writes 事件的 taskId 是任务卡 id');
  assert.equal(taskEvent.counts.writes, 2);
  assert.equal(taskEvent.counts.batches, 1);

  const listed = await getJson(app, '/api/tasks', alice.cookie);
  assert.equal(listed.tasks[0].id, taskEvent.taskId);
  assert.equal(listed.tasks[0].counts.writes, 2, '任务卡显示自动写入条数');
  assert.equal(listed.tasks[0].counts.batches, 1);

  const rows = withStore(app, alice.user, store => ({
    events: store.db.prepare('SELECT * FROM events').all(),
    projects: store.db.prepare('SELECT * FROM event_projects').all(),
    audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all()
  }));
  assert.equal(rows.events.length, 1);
  assert.equal(rows.projects.length, 1);
  assert.equal(rows.events[0].title, '西南财经大学2026届秋季双选会');
  assert.equal(rows.events[0].source_id, 'manual', 'source_id=manual 允许');
  assert.equal(rows.projects[0].company, '中国银行四川省分行');
  assert.equal(rows.projects[0].source_id, 'manual');

  assert.equal(rows.audits.length, 2, '审计与业务行 1:1');
  assert.equal(new Set(rows.audits.map(row => row.batch_id)).size, 1);
  assert.equal(rows.audits.every(row => row.task_id === taskEvent.taskId), true);
  assert.equal(rows.audits[0].old_values, null);
  assert.equal(JSON.parse(rows.audits[0].new_values).title, '西南财经大学2026届秋季双选会');
  assert.equal(JSON.parse(rows.audits[1].new_values).company, '中国银行四川省分行');

  const auditView = await getJson(app, '/api/audit?taskId=' + taskEvent.taskId, alice.cookie);
  assert.equal(auditView.batches.length, 1);
  assert.equal(auditView.batches[0].taskId, taskEvent.taskId);
  assert.deepEqual(auditView.batches[0].counts, {total: 2, create: 2, update: 0, delete: 0, skip: 0});
  assert.equal(auditView.batches[0].rows[0].oldValues, null, '旧值以 JSON 返回');
  assert.equal(auditView.batches[0].rows[0].newValues.title, '西南财经大学2026届秋季双选会');
  assert.equal(auditView.counts.batches, 1);
  assert.equal(auditView.counts.rows, 2);
  const byBatch = await getJson(app, '/api/audit?batchId=' + writes[0].batchId, alice.cookie);
  assert.equal(byBatch.batches.length, 1);
  assert.equal(byBatch.batches[0].rows.length, 2);

  // 同幂等键同参数重放（另一个任务）：不新增行、不新增审计，也不发 writes 事件。
  const secondSession = await newSession(app, alice.cookie);
  const second = await chat(app, alice.cookie, secondSession.id, '请自动写入招聘活动');
  const secondTask = second.events.filter(event => event.type === 'task').at(-1);
  assert.equal(secondTask.state, 'succeeded');
  assert.equal(second.events.filter(event => event.type === 'writes').length, 0, '重放不算新的自动写入');
  assert.equal(secondTask.counts.writes, 0);
  const afterReplay = withStore(app, alice.user, store => ({
    events: count(store, 'events'),
    projects: count(store, 'event_projects'),
    audits: count(store, 'write_audit')
  }));
  assert.equal(afterReplay.events, 1);
  assert.equal(afterReplay.projects, 1);
  assert.equal(afterReplay.audits, 2, '重放不新增审计');
  const replayTask = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(task => task.id === secondTask.taskId);
  assert.equal(replayTask.counts.writes, 0);

  // 同键不同指纹：422，业务数据不变；工具结果里能看到冲突码。
  const thirdSession = await newSession(app, alice.cookie);
  await chat(app, alice.cookie, thirdSession.id, '请自动写入另一场招聘活动');
  assert.ok(toolResults(mock).some(text => text.includes('IDEMPOTENCY_KEY_CONFLICT')), '同键不同指纹要返回冲突');
  assert.equal(withStore(app, alice.user, store => count(store, 'events')), 1);

  // 缺幂等键：400 MISSING_IDEMPOTENCY_KEY，不落库。
  const fourthSession = await newSession(app, alice.cookie);
  await chat(app, alice.cookie, fourthSession.id, '请自动写入缺少幂等键的招聘活动');
  assert.ok(toolResults(mock).some(text => text.includes('MISSING_IDEMPOTENCY_KEY')), '缺键要明确拒绝');
  const afterRejects = withStore(app, alice.user, store => ({
    events: count(store, 'events'),
    audits: count(store, 'write_audit')
  }));
  assert.equal(afterRejects.events, 1);
  assert.equal(afterRejects.audits, 2);

  // 另一个账号看不到这些审计。
  const bob = await register(app, 'bob');
  const bobAudit = await getJson(app, '/api/audit', bob.cookie);
  assert.equal(bobAudit.batches.length, 0, '审计只属于本人');
  assert.equal(bobAudit.counts.rows, 0);
});

test('HTTP：审计写失败时业务数据不落库（fail closed）', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const user = await register(app, 'fail-closed');
  await saveModel(app, user.cookie, mock.url);

  // 预先建好审计表并让审计插入必然失败。
  withStore(app, user.user, store => {
    ensureAuditSchema(store.db, 'recruit');
    store.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON write_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  });

  const session = await newSession(app, user.cookie);
  const run = await chat(app, user.cookie, session.id, '请自动写入招聘活动');
  assert.equal(run.events.filter(event => event.type === 'writes').length, 0, '失败时不能报告写入成功');
  const rows = withStore(app, user.user, store => ({
    events: count(store, 'events'),
    projects: count(store, 'event_projects'),
    audits: count(store, 'write_audit'),
    idem: count(store, 'idempotency')
  }));
  assert.equal(rows.events, 0, '业务数据必须回滚');
  assert.equal(rows.projects, 0);
  assert.equal(rows.audits, 0);
  assert.equal(rows.idem, 0);
  assert.ok(toolResults(mock).some(text => text.includes('WRITE_FAILED')), '失败要返回可读错误');
});

test('HTTP：界面上手动写入不产生审计记录', async t => {
  const app = await startApp(t);
  const user = await register(app, 'manual-user');

  const saved = await postJson(app, '/api/recruit/manual/save', user.cookie, {
    school: '西南财经大学', city: '成都', kind: '双选会',
    title: '西南财经大学2026届秋季双选会（手动）',
    startAt: '2026-11-06T09:00:00+08:00',
    venue: '柳林校区体育馆'
  });
  assert.equal(saved.ok, true);

  const afterSave = withStore(app, user.user, store => {
    const hasAuditTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='write_audit'").get();
    return {events: count(store, 'events'), audits: hasAuditTable ? count(store, 'write_audit') : 0};
  });
  assert.equal(afterSave.events, 1);
  assert.equal(afterSave.audits, 0, '手动写入不产生审计');

  // 手动新增招聘项目同样不入审计。
  await postJson(app, '/api/recruit/projects', user.cookie, {
    eventId: saved.event.id, company: '中国银行四川省分行', title: '管理培训生'
  });
  const afterProject = withStore(app, user.user, store => {
    const hasAuditTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='write_audit'").get();
    return {projects: count(store, 'event_projects'), audits: hasAuditTable ? count(store, 'write_audit') : 0};
  });
  assert.equal(afterProject.projects, 1);
  assert.equal(afterProject.audits, 0);

  const view = await getJson(app, '/api/audit', user.cookie);
  assert.equal(view.batches.length, 0);
  assert.equal(view.counts.rows, 0);
});
