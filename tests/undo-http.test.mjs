import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {bulkWriteRows} from '../src/recruit/bulk.mjs';
import {createWriteGateway} from '../src/writes/gateway.mjs';
import {summarizeTaskUndo} from '../src/writes/undo.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = {sourceId: 'manual', sourceUrl: 'https://job.swufe.edu.cn/info/1', notes: '浏览器截图读取（非采集器）'};
const EVENT = {
  title: '西南财经大学2026届秋季双选会',
  startAt: '2026-11-05T09:00:00+08:00',
  school: '西南财经大学',
  city: '成都',
  kind: '双选会',
  venue: '柳林校区体育馆',
  sourceKey: 'swufe-2026-autumn'
};
const PROJECT = {eventIndex: 0, company: '中国银行四川省分行', title: '管理培训生', positions: '若干', applyMode: '网申'};

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-undo-http-'));
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

function snapshot(store) {
  const events = store.db.prepare('SELECT * FROM events ORDER BY id').all();
  const projects = store.db.prepare('SELECT * FROM event_projects ORDER BY id').all();
  return {events, projects, hash: createHash('sha256').update(JSON.stringify({events, projects})).digest('hex')};
}

function seed(store) {
  store.upsertEvent({
    id: 'seed-event-0001', sourceId: 'manual', school: '西南财经大学', city: '成都', kind: '双选会',
    title: EVENT.title, startAt: EVENT.startAt, venue: '旧场馆', company: '旧单位',
    fetchedAt: '2026-01-01T00:00:00.000Z', confidence: 0.5, status: 'active'
  });
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

async function saveModel(app, cookie, baseUrl) {
  return postJson(app, '/api/model/save', cookie, {mode: 'local', protocol: 'chat', baseUrl, model: 'mock-model', stream: true});
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

async function chat(app, cookie, sessionId, message) {
  const response = await fetch(app.origin + '/api/chat', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify({id: sessionId, message})});
  assert.equal(response.status, 200);
  return collectEvents(response);
}

async function bulkChat(app, cookie, mock) {
  const session = await newSession(app, cookie);
  const events = await chat(app, cookie, session.id, '请自动写入招聘活动');
  const task = events.filter(event => event.type === 'task').at(-1);
  const writes = events.filter(event => event.type === 'writes');
  assert.equal(task.state, 'succeeded');
  assert.equal(writes.length, 1);
  return {task, batchId: writes[0].batchId};
}

test('HTTP：干净撤销后数据回到写入前，审计新增 undo_of，任务卡标记已撤销', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'undo-clean');
  await saveModel(app, alice.cookie, mock.url);
  const before = withStore(app, alice.user, store => { seed(store); return snapshot(store); });

  const {task, batchId} = await bulkChat(app, alice.cookie, mock);
  const preview = await getJson(app, '/api/audit/preview?batchId=' + batchId, alice.cookie);
  assert.equal(preview.scope, 'batch');
  assert.equal(preview.counts.rows, 2);
  assert.equal(preview.counts.ready, 2);
  assert.equal(preview.counts.conflicts, 0);

  const card = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(item => item.id === task.taskId);
  assert.equal(card.undo.available, true, '任务卡要显示可撤销');
  assert.equal(card.undo.rows, 2);
  assert.match(card.undo.summary, /可撤销 2 条/);

  const undone = await postJson(app, '/api/audit/undo/batch', alice.cookie, {batchId});
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.counts, {rows: 2, undone: 2, conflicts: 0, forced: 0, failed: 0, already: 0});
  assert.match(undone.newBatchId, /^[0-9a-f-]{36}$/);
  assert.ok(undone.undo.allUndone);
  assert.equal(undone.task.state, 'undone', '全部批次撤销后任务标记已撤销');

  const after = withStore(app, alice.user, store => snapshot(store));
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.projects, before.projects);
  assert.equal(after.hash, before.hash);

  const view = await getJson(app, '/api/audit?taskId=' + task.taskId, alice.cookie);
  assert.equal(view.batches.length, 2, '原批次 + 撤销批次');
  assert.equal(view.batches[0].batchId, undone.newBatchId, '新撤销批次排在最前');
  assert.equal(view.batches[0].rows.every(row => row.undoOf), true);
  assert.deepEqual(view.batches[0].rows.map(row => row.undoOf).sort(), view.batches[1].rows.map(row => row.eventId).sort());

  const tasks = await getJson(app, '/api/tasks', alice.cookie);
  assert.equal(tasks.tasks.find(item => item.id === task.taskId).state, 'undone');
  assert.equal(tasks.tasks.find(item => item.id === task.taskId).undo.available, false);
});

test('HTTP：手工改过一行再撤销 skip + 其余撤销；强制撤销写回旧值且审计同时有 skip 与 forced', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'undo-conflict');
  await saveModel(app, alice.cookie, mock.url);
  const before = withStore(app, alice.user, store => { seed(store); return snapshot(store); });
  const {task, batchId} = await bulkChat(app, alice.cookie, mock);
  withStore(app, alice.user, store => {
    store.db.prepare("UPDATE events SET title='我手工改过的标题', venue='我换的场馆' WHERE id=?").run('seed-event-0001');
  });

  const conflicted = await postJson(app, '/api/audit/undo/batch', alice.cookie, {batchId});
  assert.deepEqual(conflicted.counts, {rows: 2, undone: 1, conflicts: 1, forced: 0, failed: 0, already: 0});
  assert.equal(conflicted.results.find(item => item.entity === 'events').result, 'skipped_conflict');
  assert.equal(withStore(app, alice.user, store => store.getEvent('seed-event-0001').title), '我手工改过的标题', '不能静默覆盖手工修改');
  assert.equal(withStore(app, alice.user, store => store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c), 0);
  const afterSkip = withStore(app, alice.user, store => snapshot(store));
  assert.equal(afterSkip.projects.length, 0, '除冲突行外已回到写入前');
  assert.ok(conflicted.task, '返回任务卡');
  assert.notEqual(conflicted.task.state, 'undone', '还有冲突时任务不能标记已撤销');
  assert.match(conflicted.undo.summary, /冲突/);

  const forced = await postJson(app, '/api/audit/undo/batch', alice.cookie, {batchId, force: true});
  assert.equal(forced.counts.forced, 1);
  assert.equal(forced.results.find(item => item.entity === 'events').result, 'forced');
  assert.deepEqual(withStore(app, alice.user, store => snapshot(store)).events, before.events, '强制写回旧值');
  assert.equal(forced.task.state, 'undone');

  const audits = withStore(app, alice.user, store => store.db.prepare("SELECT * FROM write_audit WHERE undo_of!='' ORDER BY seq").all());
  const eventUndo = audits.filter(row => row.entity === 'events');
  assert.deepEqual(eventUndo.map(row => row.result), ['skipped_conflict', 'skipped_conflict', 'forced'], '第一次 skip、强制时再 skip + forced');
  assert.ok(eventUndo.some(row => row.result === 'skipped_conflict') && eventUndo.some(row => row.result === 'forced'), '审计同时有 skip 与 forced');
  assert.ok(eventUndo.every(row => row.batch_id !== batchId), '撤销行在新批次里');
  const taskView = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(item => item.id === task.taskId);
  assert.equal(taskView.state, 'undone');
  assert.match(taskView.undo.summary, /强制覆盖/);
});

test('HTTP：任务级撤销按批次新→旧、聚合计数，任务卡撤销摘要更新', async t => {
  const app = await startApp(t);
  const alice = await register(app, 'undo-task');
  const before = withStore(app, alice.user, store => snapshot(store));
  const session = await newSession(app, alice.cookie);

  const dataDir = join(app.dataDir, 'users', alice.user.id, '.data');
  const outcome = await app.tasks.run({
    userId: alice.user.id,
    sessionId: session.id,
    title: '两个批次的任务',
    sourceName: '对话',
    describeUndo: ({task}) => summarizeTaskUndo({dir: dataDir, userId: alice.user.id, taskId: task.id}),
    execute: async ({task}) => {
      const store = RecruitStore.open(dbPath(app, alice.user));
      try {
        const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: alice.user.id, taskId: task.id});
        const second = {...EVENT, title: '西南财经大学2026届秋季双选会（第二场）', startAt: '2026-11-06T09:00:00+08:00', sourceKey: 'swufe-2026-autumn-2'};
        await gateway.write({
          tool: 'career_recruit_bulk_write', sensitivity: 'auto',
          payload: {events: [EVENT], projects: [PROJECT], source: SOURCE}, idempotencyKey: 'multi-1', sourceRef: SOURCE,
          execute: () => bulkWriteRows({store, events: [EVENT], projects: [PROJECT], source: SOURCE})
        });
        await gateway.write({
          tool: 'career_recruit_bulk_write', sensitivity: 'auto',
          payload: {events: [second], source: SOURCE}, idempotencyKey: 'multi-2', sourceRef: SOURCE,
          execute: () => bulkWriteRows({store, events: [second], source: SOURCE})
        });
      } finally { store.close(); }
      return {reply: '完成'};
    }
  });
  assert.equal(outcome.task.state, 'succeeded');
  const card = (await getJson(app, '/api/tasks', alice.cookie)).tasks.find(item => item.id === outcome.task.id);
  assert.equal(card.undo.available, true);
  assert.equal(card.undo.batches, 2);
  assert.equal(card.undo.rows, 3, '第一批发 2 行、第二批发 1 行');

  const undone = await postJson(app, '/api/audit/undo/task', alice.cookie, {taskId: outcome.task.id});
  assert.equal(undone.scope, 'task');
  assert.equal(undone.counts.batches, 2);
  assert.equal(undone.counts.batchesUndone, 2);
  assert.equal(undone.counts.undone, 3);
  assert.equal(undone.counts.conflicts, 0);
  assert.equal(undone.counts.failed, 0);
  assert.equal(undone.batches.length, 2, '每个批次都有结果');
  assert.ok(undone.batches[0].results.length >= 1);
  assert.equal(undone.task.state, 'undone');

  const after = withStore(app, alice.user, store => snapshot(store));
  assert.deepEqual(after.events, before.events);
  assert.equal(after.hash, before.hash);

  // 再撤一次：没有可撤销行，任务保持已撤销。
  const again = await postJson(app, '/api/audit/undo/task', alice.cookie, {taskId: outcome.task.id});
  assert.equal(again.counts.undone, 0);
  assert.equal(again.task.state, 'undone');

  const bob = await register(app, 'undo-bob');
  await getJson(app, '/api/audit/preview?taskId=' + outcome.task.id, bob.cookie).then(body => {
    assert.equal(body.batches.length, 0, '别人的任务看不到审计');
  });
});

test('HTTP：别人的批次不能预览或撤销，未知批次 404', async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const app = await startApp(t);
  const alice = await register(app, 'undo-owner');
  const bob = await register(app, 'undo-intruder');
  await saveModel(app, alice.cookie, mock.url);
  const {batchId} = await bulkChat(app, alice.cookie, mock);

  await getJson(app, '/api/audit/preview?batchId=' + batchId, bob.cookie, 404);
  await postJson(app, '/api/audit/undo/batch', bob.cookie, {batchId}, 404);
  await postJson(app, '/api/audit/undo/batch', alice.cookie, {batchId: '11111111-1111-7111-8111-111111111111'}, 404);
  await getJson(app, '/api/audit/preview', alice.cookie, 400);
});
