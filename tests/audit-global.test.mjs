import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {createWriteGateway} from '../src/writes/gateway.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PHRASE = '清空我的审计';

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-audit-global-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function dbPath(app, user) {
  return join(app.dataDir, 'users', user.id, '.data', 'recruit.db');
}

function withStore(app, user, fn) {
  const store = RecruitStore.open(dbPath(app, user));
  try { return fn(store); } finally { store.close(); }
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

async function rawGet(app, path, cookie) {
  return fetch(app.origin + path, {headers: headers(app, cookie)});
}

// 直接经写网关造审计：时间/发起者/工具/任务都按参数固定，不经过模型，避免测试依赖上游。
async function seedBatch(app, user, {taskId, actorType, actorRef, tool, at, changes, domain = 'recruit'}) {
  const store = RecruitStore.open(dbPath(app, user));
  try {
    const gateway = createWriteGateway({db: store.db, domain, userId: user.id, taskId, actorType, actorRef, now: () => new Date(at)});
    return await gateway.write({
      tool,
      payload: {taskId, at, changes},
      idempotencyKey: 'seed-' + taskId,
      sourceRef: {sourceId: 'manual'},
      execute: () => changes
    });
  } finally { store.close(); }
}

async function seedConfirmation(app, user) {
  const store = RecruitStore.open(dbPath(app, user));
  try {
    const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: user.id, taskId: '', actorType: 'model', actorRef: 'api:mock'});
    return await gateway.write({
      tool: 'career_profile_write',
      sensitivity: 'sensitive',
      payload: {facts: [{key: '目标城市', value: '成都'}]},
      idempotencyKey: 'seed-confirm-' + user.id,
      preview: {facts: [{key: '目标城市', value: '成都'}]},
      execute: () => []
    });
  } finally { store.close(); }
}

// 三个批次：1 月（model）、2 月（agent）、3 月（user 撤销），实体与工具各不相同。
async function seedThreeBatches(app, user) {
  const task1 = randomUUID();
  const task2 = randomUUID();
  const task3 = randomUUID();
  await seedBatch(app, user, {
    taskId: task1, actorType: 'model', actorRef: 'api:mock', tool: 'career_recruit_bulk_write',
    at: '2026-01-05T10:00:00.000Z',
    changes: [
      {action: 'create', entity: 'events', entityId: 'evt-jan', newValues: {id: 'evt-jan', title: '一月活动'}},
      {action: 'create', entity: 'event_projects', entityId: 'prj-jan', newValues: {id: 'prj-jan', company: '一月单位'}}
    ]
  });
  await seedBatch(app, user, {
    taskId: task2, actorType: 'agent', actorRef: 'mcp__review__write_events', tool: 'mcp__review__write_events',
    at: '2026-02-05T10:00:00.000Z',
    changes: [
      {action: 'update', entity: 'events', entityId: 'evt-feb', oldValues: {id: 'evt-feb', title: '旧标题'}, newValues: {id: 'evt-feb', title: '二月活动'}}
    ]
  });
  await seedBatch(app, user, {
    taskId: task3, actorType: 'user', actorRef: 'undo', tool: 'career_recruit_bulk_write',
    at: '2026-03-05T10:00:00.000Z',
    changes: [
      {action: 'create', entity: 'event_projects', entityId: 'prj-mar', newValues: {id: 'prj-mar', company: '三月单位'}}
    ]
  });
  return {task1, task2, task3};
}

test('HTTP 筛选：时间、发起者、工具、实体、任务都在后端过滤且只返回本人数据', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'audit-filter');
  const bob = await register(app, 'audit-filter-bob');
  const {task1, task2, task3} = await seedThreeBatches(app, alice.user);

  const all = await getJson(app, '/api/audit', alice.cookie);
  assert.equal(all.batches.length, 3);
  assert.deepEqual(all.counts, {batches: 3, rows: 4, create: 3, update: 1, delete: 0, skip: 0});

  // 时间区间：只留 2 月这一批。
  const byTime = await getJson(app, '/api/audit?from=2026-02-01T00:00:00Z&to=2026-02-28T23:59:59Z', alice.cookie);
  assert.equal(byTime.batches.length, 1);
  assert.equal(byTime.batches[0].taskId, task2);
  assert.deepEqual(byTime.counts, {batches: 1, rows: 1, create: 0, update: 1, delete: 0, skip: 0});

  // 发起者类型 / 精确引用。
  assert.deepEqual((await getJson(app, '/api/audit?actorType=agent', alice.cookie)).batches.map(batch => batch.taskId), [task2]);
  assert.deepEqual((await getJson(app, '/api/audit?actorRef=api%3Amock', alice.cookie)).batches.map(batch => batch.taskId), [task1]);

  // 工具过滤命中两个批次（1 月与 3 月）。
  const byTool = await getJson(app, '/api/audit?tool=career_recruit_bulk_write', alice.cookie);
  assert.equal(byTool.batches.length, 2);
  assert.equal(byTool.counts.rows, 3);
  assert.deepEqual(byTool.batches.flatMap(batch => batch.rows.map(row => row.tool)), ['career_recruit_bulk_write', 'career_recruit_bulk_write', 'career_recruit_bulk_write']);

  // 实体过滤：批次里只保留命中的行，行数由后端给。
  const byEntity = await getJson(app, '/api/audit?entity=events', alice.cookie);
  assert.equal(byEntity.batches.length, 2);
  assert.equal(byEntity.counts.rows, 2);
  assert.ok(byEntity.batches.every(batch => batch.rows.every(row => row.entity === 'events')), '不能把未命中的行混进筛选结果');

  // 任务过滤沿用 #31 的每任务视图。
  const byTask = await getJson(app, '/api/audit?taskId=' + task3, alice.cookie);
  assert.equal(byTask.batches.length, 1);
  assert.equal(byTask.batches[0].taskId, task3);

  // 组合筛选。
  const combined = await getJson(app, '/api/audit?actorType=agent&entity=events', alice.cookie);
  assert.equal(combined.batches.length, 1);
  assert.equal(combined.batches[0].taskId, task2);

  // 非法时间返回 400，不是静默忽略。
  await getJson(app, '/api/audit?from=not-a-date', alice.cookie, 400);

  // 跨用户：Bob 只有自己的；拿 Alice 的 taskId 也看不到。
  await seedBatch(app, bob.user, {
    taskId: randomUUID(), actorType: 'model', actorRef: 'api:mock', tool: 'career_recruit_bulk_write',
    at: '2026-01-06T10:00:00.000Z',
    changes: [{action: 'create', entity: 'events', entityId: 'evt-bob', newValues: {id: 'evt-bob', title: 'Bob 的活动'}}]
  });
  const bobView = await getJson(app, '/api/audit', bob.cookie);
  assert.equal(bobView.batches.length, 1);
  assert.equal(bobView.batches[0].rows[0].entityId, 'evt-bob');
  assert.equal((await getJson(app, '/api/audit?taskId=' + task1, bob.cookie)).batches.length, 0);
});

test('HTTP 导出：JSON 与 CSV 都由服务端生成，内容与当前筛选一致，且只含本人行', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'audit-export');
  await seedThreeBatches(app, alice.user);

  const jsonResponse = await rawGet(app, '/api/audit/export?format=json&entity=events', alice.cookie);
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get('content-type'), /application\/json/);
  assert.match(jsonResponse.headers.get('content-disposition'), /attachment; filename="career-audit-[0-9]{14}\.json"/);
  const exported = await jsonResponse.json();
  assert.deepEqual(exported.counts, {batches: 2, rows: 2, create: 1, update: 1, delete: 0, skip: 0});
  assert.equal(exported.batches.length, 2);
  const jsonRows = exported.batches.flatMap(batch => batch.rows);
  assert.equal(jsonRows.length, 2);
  assert.ok(jsonRows.every(row => row.entity === 'events'));
  assert.ok(jsonRows.every(row => row && Object.hasOwn(row, 'oldValues') && Object.hasOwn(row, 'newValues')));
  assert.equal(jsonRows.find(row => row.entityId === 'evt-jan').newValues.title, '一月活动');
  assert.equal(jsonRows.find(row => row.entityId === 'evt-feb').oldValues.title, '旧标题');
  assert.equal(exported.filters.entity, 'events');

  const csvResponse = await rawGet(app, '/api/audit/export?format=csv&actorType=agent', alice.cookie);
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /attachment; filename="career-audit-[0-9]{14}\.csv"/);
  assert.deepEqual(JSON.parse(csvResponse.headers.get('x-audit-counts')), {batches: 1, rows: 1, create: 0, update: 1, delete: 0, skip: 0});
  const csv = await csvResponse.text();
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.equal(lines.length, 2, '表头 + 1 行数据');
  assert.match(lines[0], /seq,.*oldValues,.*newValues/);
  assert.match(lines[1], /evt-feb/);
  assert.match(lines[1], /旧标题/);
  assert.match(lines[1], /二月活动/);

  await rawGet(app, '/api/audit/export?format=xml', alice.cookie).then(async response => {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_FORMAT');
  });
});

test('HTTP 清空：必须输入指定短语，只删本人审计与确认，保留幂等行并记 last_cleared_at', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'audit-clear');
  const bob = await register(app, 'audit-clear-bob');
  const {task1} = await seedThreeBatches(app, alice.user);
  await seedConfirmation(app, alice.user);
  await seedBatch(app, bob.user, {
    taskId: randomUUID(), actorType: 'model', actorRef: 'api:mock', tool: 'career_recruit_bulk_write',
    at: '2026-01-07T10:00:00.000Z',
    changes: [{action: 'create', entity: 'events', entityId: 'evt-bob-clear', newValues: {id: 'evt-bob-clear', title: 'Bob 的活动'}}]
  });
  await seedConfirmation(app, bob.user);

  const before = withStore(app, alice.user, store => ({
    audit: store.db.prepare('SELECT COUNT(*) c FROM write_audit WHERE user_id=?').get(alice.user.id).c,
    confirmations: store.db.prepare('SELECT COUNT(*) c FROM confirmations WHERE user_id=?').get(alice.user.id).c,
    idempotency: store.db.prepare('SELECT COUNT(*) c FROM idempotency WHERE user_id=?').get(alice.user.id).c
  }));
  assert.equal(before.audit, 4);
  assert.equal(before.confirmations, 1);
  assert.ok(before.idempotency >= 4);

  // 短语不对：400，且一行都不删。
  const wrong = await postJson(app, '/api/audit/clear', alice.cookie, {phrase: '清空'}, 400);
  assert.equal(wrong.code, 'INVALID_PHRASE');
  assert.match(wrong.error, /清空我的审计/);
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM write_audit WHERE user_id=?').get(alice.user.id).c), 4);
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM confirmations WHERE user_id=?').get(alice.user.id).c), 1);
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM idempotency WHERE user_id=?').get(alice.user.id).c), before.idempotency);

  const cleared = await postJson(app, '/api/audit/clear', alice.cookie, {phrase: PHRASE});
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.counts, {domains: 1, batches: 3, rows: 4, confirmations: 1});
  assert.match(cleared.lastClearedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM write_audit WHERE user_id=?').get(alice.user.id).c), 0);
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM confirmations WHERE user_id=?').get(alice.user.id).c), 0);
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM idempotency WHERE user_id=?').get(alice.user.id).c), before.idempotency, '幂等行保留到 TTL');
  const meta = withStore(app, alice.user, store => store.db.prepare("SELECT last_cleared_at FROM audit_meta WHERE domain='recruit'").get());
  assert.equal(meta.last_cleared_at, cleared.lastClearedAt);

  const after = await getJson(app, '/api/audit', alice.cookie);
  assert.equal(after.batches.length, 0);
  assert.equal(after.counts.rows, 0);
  assert.equal(after.lastClearedAt, cleared.lastClearedAt);
  assert.equal(after.clearPhrase, PHRASE);
  const emptyExport = await getJson(app, '/api/audit/export?format=json', alice.cookie);
  assert.equal(emptyExport.counts.rows, 0);

  // 从来没有自动写入的账号也能清空：计数为 0，但 last_cleared_at 仍然留下。
  const carol = await register(app, 'audit-clear-empty');
  const emptyCleared = await postJson(app, '/api/audit/clear', carol.cookie, {phrase: PHRASE});
  assert.equal(emptyCleared.ok, true);
  assert.deepEqual(emptyCleared.counts, {domains: 1, batches: 0, rows: 0, confirmations: 0});
  assert.match(emptyCleared.lastClearedAt, /^\d{4}-\d{2}-\d{2}T/);
  const carolView = await getJson(app, '/api/audit', carol.cookie);
  assert.equal(carolView.lastClearedAt, emptyCleared.lastClearedAt);

  // 另一个账号的审计与确认不受影响；也不能用他的 id 导出 Alice 的行。
  const bobView = await getJson(app, '/api/audit', bob.cookie);
  assert.equal(bobView.batches.length, 1);
  assert.equal(withStore(app, bob.user, store => store.db.prepare('SELECT COUNT(*) c FROM confirmations WHERE user_id=?').get(bob.user.id).c), 1);
  await getJson(app, '/api/audit?taskId=' + task1, bob.cookie).then(body => assert.equal(body.batches.length, 0));
  const bobExport = await getJson(app, '/api/audit/export?format=json&taskId=' + task1, bob.cookie);
  assert.equal(bobExport.counts.rows, 0, '别人导出不到 Alice 的审计行');
});
