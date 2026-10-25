import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {openProfileDb, listProfileFacts} from '../src/profile/store.mjs';
import {ensureAuditSchema} from '../src/writes/audit-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-confirm-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
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

async function chat(app, cookie, message) {
  const session = await newSession(app, cookie);
  const response = await fetch(app.origin + '/api/chat', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify({id: session.id, message})});
  assert.equal(response.status, 200);
  const events = await collectEvents(response);
  return {events, task: events.filter(event => event.type === 'task').at(-1)};
}

function profileDir(app, user) {
  return join(app.dataDir, 'users', user.id, '.data');
}

function withProfile(app, user, fn) {
  const db = openProfileDb(join(profileDir(app, user), 'profile.db'));
  try { return fn(db); } finally { db.close(); }
}

// 走一遍真实会话：模型请求敏感写 -> 返回 confirm_required -> 任务卡拿到待确认。
async function requestConfirmation(app, user, message) {
  const run = await chat(app, user.cookie, message);
  const event = run.events.find(item => item.type === 'confirm_required');
  assert.ok(event, message + ' 应返回 confirm_required 事件；实际事件：' + run.events.map(item => item.type).join(','));
  assert.match(event.confirmId, UUID7);
  assert.equal(event.taskId, run.task.taskId);
  assert.ok(event.expiresAt);
  assert.ok(!JSON.stringify(event.preview).includes('13800138000'), 'confirm_required 预览要脱敏');
  const states = run.events.filter(item => item.type === 'task').map(item => item.state);
  assert.ok(states.includes('waiting_confirmation'), '任务应先进入待确认；实际状态：' + states.join(' -> '));
  assert.equal(run.task.state, 'waiting_confirmation', '有敏感写入待确认时任务停在待确认，不冒充成功');
  const listed = await getJson(app, '/api/tasks', user.cookie);
  const card = listed.tasks.find(task => task.id === run.task.taskId);
  assert.equal(card.state, 'waiting_confirmation');
  assert.equal(listed.badge, 1, '待确认计入徽标');
  return {event, run, states};
}

test('HTTP：敏感写入先挂起确认，没有业务行；任务卡待确认区能取到脱敏预览', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);

  const {event, run} = await requestConfirmation(app, alice, '请写入长期画像');
  assert.equal(withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id).length), 0, '未确认不落业务行');

  const pending = await getJson(app, '/api/confirmations?taskId=' + run.task.taskId, alice.cookie);
  assert.equal(pending.confirmations.length, 1);
  assert.equal(pending.confirmations[0].confirmId, event.confirmId);
  assert.equal(pending.confirmations[0].tool, 'career_profile_write');
  assert.equal(pending.confirmations[0].domain, 'profile');
  assert.equal(pending.confirmations[0].taskId, run.task.taskId);
  assert.equal(pending.confirmations[0].decision, 'pending');
  assert.ok(!JSON.stringify(pending.confirmations[0].preview).includes('13800138000'));
  assert.match(JSON.stringify(pending.confirmations[0].preview), /成都/);
  assert.equal(pending.counts.pending, 1);

  const all = await getJson(app, '/api/confirmations', alice.cookie);
  assert.equal(all.confirmations.length, 1, '不带 taskId 时列出本人全部待确认');

  const bob = await register(app, 'bob');
  const bobPending = await getJson(app, '/api/confirmations?taskId=' + run.task.taskId, bob.cookie);
  assert.equal(bobPending.confirmations.length, 0, '确认只属于本人');
});

test('HTTP：接受确认原子落库并写审计；重复接受幂等；审计区可见 confirmed 批次', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);
  const {event, run} = await requestConfirmation(app, alice, '请写入长期画像');

  const accepted = await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: event.confirmId});
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'applied');
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.confirmed, true);
  assert.match(accepted.batchId, UUID7);
  assert.deepEqual(accepted.counts, {rows: 2, created: 2, updated: 0, deleted: 0, skipped: 0});

  const facts = withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id));
  assert.equal(facts.length, 2);
  assert.equal(facts.find(fact => fact.key === '城市偏好').value, '成都');

  const audit = await getJson(app, '/api/audit?taskId=' + run.task.taskId, alice.cookie);
  assert.equal(audit.batches.length, 1);
  assert.equal(audit.batches[0].tool, 'career_profile_write');
  assert.equal(audit.batches[0].domain, 'profile');
  assert.equal(audit.batches[0].rows.length, 2);
  assert.equal(audit.batches[0].rows.every(row => row.confirmed === true), true, '审计行标 confirmed');
  assert.equal(audit.batches[0].rows[0].confirmId, event.confirmId);

  const tasks = await getJson(app, '/api/tasks', alice.cookie);
  const card = tasks.tasks.find(task => task.id === run.task.taskId);
  assert.equal(card.state, 'succeeded', '接受后任务收尾为成功');
  assert.equal(card.counts.writes, 2, '接受写入的条数并进任务卡');
  assert.equal(card.counts.batches, 1);
  assert.equal(tasks.badge, 0);

  const again = await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: event.confirmId});
  assert.equal(again.duplicate, true);
  assert.equal(again.batchId, accepted.batchId);
  assert.equal(withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id).length), 2, '重复接受不第二次写入');
  const afterAgain = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(task => task.id === run.task.taskId);
  assert.equal(afterAgain.counts.writes, 2, '重复接受不重复累加任务卡写入条数');

  const failed = await getJson(app, '/api/confirmations?taskId=' + run.task.taskId, alice.cookie);
  assert.equal(failed.confirmations.length, 0, '已接受的确认不再出现在待确认里');
  const history = await getJson(app, '/api/confirmations?taskId=' + run.task.taskId + '&state=all', alice.cookie);
  assert.equal(history.confirmations.length, 1);
  assert.equal(history.confirmations[0].decision, 'accepted');
  assert.ok(history.confirmations[0].executedAt);
});

test('HTTP：拒绝确认留记录不落库；拒绝后再接受 403；过期 410；参数变化 422；跨用户 404', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);

  const rejected = await requestConfirmation(app, alice, '请写入第二条长期画像');
  const decision = await postJson(app, '/api/confirmations/reject', alice.cookie, {confirmId: rejected.event.confirmId, reason: '不想写'});
  assert.equal(decision.decision, 'rejected');
  assert.equal(decision.duplicate, false);
  assert.ok(decision.rejectedAt);
  assert.equal(withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id).length), 0, '拒绝不落业务行');
  const rejectedRecord = await getJson(app, '/api/confirmations?taskId=' + rejected.run.task.taskId + '&state=all', alice.cookie);
  assert.equal(rejectedRecord.confirmations[0].decision, 'rejected');
  assert.equal(rejectedRecord.confirmations[0].reason, '不想写');
  const afterReject = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(task => task.id === rejected.run.task.taskId);
  assert.equal(afterReject.state, 'succeeded', '拒绝后任务也算处理完');
  assert.equal(afterReject.counts.writes, 0, '拒绝不增加写入条数');
  await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: rejected.event.confirmId}, 403);

  const expiring = await requestConfirmation(app, alice, '请写入第三条长期画像');
  withProfile(app, alice.user, db => {
    db.prepare('UPDATE confirmations SET expires_at=? WHERE confirm_id=?').run(new Date(Date.now() - 1000).toISOString(), expiring.event.confirmId);
  });
  const expired = await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: expiring.event.confirmId}, 410);
  assert.equal(expired.code, 'CONFIRMATION_EXPIRED');

  const tampered = await requestConfirmation(app, alice, '请写入第四条长期画像');
  withProfile(app, alice.user, db => {
    db.prepare('UPDATE confirmations SET payload_json=? WHERE confirm_id=?')
      .run(JSON.stringify({facts: [{key: '期望城市 4', value: '北京'}]}), tampered.event.confirmId);
  });
  const mismatch = await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: tampered.event.confirmId}, 422);
  assert.equal(mismatch.code, 'CONFIRMATION_MISMATCH');

  const bob = await register(app, 'bob');
  const foreign = await postJson(app, '/api/confirmations/accept', bob.cookie, {confirmId: tampered.event.confirmId}, 404);
  assert.equal(foreign.code, 'CONFIRMATION_NOT_FOUND');
  await postJson(app, '/api/confirmations/reject', bob.cookie, {confirmId: tampered.event.confirmId}, 404);

  await postJson(app, '/api/confirmations/accept', alice.cookie, {}, 400);
  await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: '00000000-0000-0000-0000-000000000000'}, 404);
  assert.equal(withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id).length), 0, '所有边界都不落业务行');
});

test('HTTP：审计写失败时接受确认整体回滚（业务行与确认状态）', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'alice');
  await saveModel(app, alice.cookie, mock.url);
  const {event} = await requestConfirmation(app, alice, '请写入长期画像');
  withProfile(app, alice.user, db => {
    ensureAuditSchema(db, 'profile');
    db.exec("CREATE TRIGGER fail_confirm_http BEFORE INSERT ON write_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  });
  const failed = await postJson(app, '/api/confirmations/accept', alice.cookie, {confirmId: event.confirmId}, 500);
  assert.equal(failed.code, 'WRITE_FAILED');
  assert.equal(withProfile(app, alice.user, db => listProfileFacts(db, alice.user.id).length), 0, '业务行回滚');
  const pending = await getJson(app, '/api/confirmations', alice.cookie);
  assert.equal(pending.confirmations.length, 1, '确认没有被消费，仍可重试');
  assert.equal(pending.confirmations[0].decision, 'pending');
  const task = (await getJson(app, '/api/tasks', alice.cookie)).tasks[0];
  assert.equal(task.state, 'waiting_confirmation', '接受失败时任务继续等待确认');
});
