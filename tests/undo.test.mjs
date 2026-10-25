import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {RecruitStore} from '../src/recruit/store.mjs';
import {bulkWriteRows} from '../src/recruit/bulk.mjs';
import {createWriteGateway} from '../src/writes/gateway.mjs';
import {undoBatch, undoTask, previewUndo, summarizeTaskUndo} from '../src/writes/undo.mjs';

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

// 快照包含整行（所有列与时间戳）+ 内容哈希：撤销后必须与写入前完全一致。
export function snapshot(store) {
  const events = store.db.prepare('SELECT * FROM events ORDER BY id').all();
  const projects = store.db.prepare('SELECT * FROM event_projects ORDER BY id').all();
  const hash = createHash('sha256').update(JSON.stringify({events, projects})).digest('hex');
  return {events, projects, hash};
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-undo-'));
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  t.after(async () => {
    try { store.close(); } catch { /* 已关闭 */ }
    await rm(dir, {recursive: true, force: true});
  });
  return {dir, store};
}

// 先手工放一条活动（界面写入，不产生审计），下一批自动写入会更新它并新增一个项目。
function seedEvent(store, overrides = {}) {
  store.upsertEvent({
    id: 'seed-event-0001', sourceId: 'manual', school: '西南财经大学', city: '成都', kind: '双选会',
    title: EVENT.title, startAt: EVENT.startAt, venue: '旧场馆', company: '旧单位',
    fetchedAt: '2026-01-01T00:00:00.000Z', confidence: 0.5, status: 'active', ...overrides
  });
}

async function autoWrite(store, {taskId = 'task-undo-1', idempotencyKey = 'idem-undo-1'} = {}) {
  const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: 'user-a', taskId});
  return gateway.write({
    tool: 'career_recruit_bulk_write',
    sensitivity: 'auto',
    payload: {events: [EVENT], projects: [PROJECT], source: SOURCE},
    idempotencyKey,
    sourceRef: SOURCE,
    execute: () => bulkWriteRows({store, events: [EVENT], projects: [PROJECT], source: SOURCE})
  });
}

test('干净撤销：批量写入后撤销，行 + 内容哈希回到写入前，审计新增 undo_of 与新批次', async t => {
  const {dir, store} = await setup(t);
  seedEvent(store);
  const before = snapshot(store);

  const outcome = await autoWrite(store);
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.counts.rows, 2, '一批里一行更新、一行新增');
  const afterWrite = snapshot(store);
  assert.notEqual(afterWrite.hash, before.hash);

  const undo = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId});
  assert.equal(undo.ok, true);
  assert.equal(undo.batchId, outcome.batchId);
  assert.match(undo.newBatchId, /^[0-9a-f-]{36}$/);
  assert.notEqual(undo.newBatchId, outcome.batchId, '撤销本身是新批次');
  assert.deepEqual(undo.counts, {rows: 2, undone: 2, conflicts: 0, forced: 0, failed: 0, already: 0});

  const afterUndo = snapshot(store);
  assert.deepEqual(afterUndo.events, before.events, '活动行要逐列恢复（含时间戳）');
  assert.deepEqual(afterUndo.projects, before.projects, '新增的项目行要被删除');
  assert.equal(afterUndo.hash, before.hash, '行 + 内容哈希必须与写入前一致');

  const audits = store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
  const originals = audits.filter(row => !row.undo_of);
  const undoRows = audits.filter(row => row.undo_of);
  assert.equal(originals.length, 2, '原写入审计保留');
  assert.equal(undoRows.length, 2, '每撤销一行新增一条审计');
  assert.equal(new Set(undoRows.map(row => row.batch_id)).size, 1, '撤销行共享同一个新 batch_id');
  assert.equal(undoRows[0].batch_id, undo.newBatchId);
  assert.deepEqual(undoRows.map(row => row.undo_of).sort(), originals.map(row => row.event_id).sort());
  assert.equal(undoRows.every(row => row.result === 'applied'), true, '干净撤销记为 applied');
  assert.equal(undoRows.every(row => row.task_id === 'task-undo-1'), true);

  const summary = summarizeTaskUndo({dir, userId: 'user-a', taskId: 'task-undo-1'});
  assert.equal(summary.available, false);
  assert.equal(summary.allUndone, true);
  assert.equal(summary.rows, 2);
  assert.equal(summary.undone, 2);
});
test('手工改过一行再撤销：改过的行 skip、其余撤销，计数正确且不覆盖手工修改', async t => {
  const {dir, store} = await setup(t);
  seedEvent(store);
  const outcome = await autoWrite(store);
  store.db.prepare("UPDATE events SET title='我手工改过的标题', notes='手工备注' WHERE id=?").run('seed-event-0001');

  const undo = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId});
  assert.deepEqual(undo.counts, {rows: 2, undone: 1, conflicts: 1, forced: 0, failed: 0, already: 0});
  const event = store.getEvent('seed-event-0001');
  assert.equal(event.title, '我手工改过的标题', '冲突行不能被悄悄覆盖');
  assert.equal(event.notes, '手工备注');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 0, '没冲突的行照常撤销');

  const results = new Map(undo.results.map(item => [item.entity, item]));
  assert.equal(results.get('events').result, 'skipped_conflict');
  assert.equal(results.get('events').conflict, true);
  assert.equal(results.get('event_projects').result, 'undone');

  const audits = store.db.prepare("SELECT * FROM write_audit WHERE undo_of!='' ORDER BY seq").all();
  const skip = audits.find(row => row.result === 'skipped_conflict');
  assert.ok(skip, '冲突要留下 skip 审计行');
  assert.equal(skip.action, 'skip');
  assert.equal(JSON.parse(skip.old_values).title, '我手工改过的标题', 'skip 行记录冲突时的当前值');
  assert.equal(JSON.parse(skip.new_values).title, EVENT.title, 'skip 行也记录想写回的值');
  assert.equal(audits.length, 2, '一条 skip + 一条已撤销');

  const summary = summarizeTaskUndo({dir, userId: 'user-a', taskId: 'task-undo-1'});
  assert.equal(summary.available, true);
  assert.equal(summary.undone, 1);
  assert.equal(summary.conflicts, 1);
  assert.match(summary.summary, /冲突/);
});

test('强制撤销：写回旧值并记 forced，审计同时有 skip 与 forced', async t => {
  const {dir, store} = await setup(t);
  seedEvent(store);
  const before = snapshot(store);
  const outcome = await autoWrite(store);
  store.db.prepare("UPDATE events SET title='我手工改过的标题', venue='我换的场馆' WHERE id=?").run('seed-event-0001');

  const undo = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId, force: true});
  assert.deepEqual(undo.counts, {rows: 2, undone: 2, conflicts: 1, forced: 1, failed: 0, already: 0});
  const eventResult = undo.results.find(item => item.entity === 'events');
  assert.equal(eventResult.result, 'forced');
  assert.equal(eventResult.undoAction, 'update');

  const after = snapshot(store);
  assert.deepEqual(after.events, before.events, '强制撤销要把旧值逐列写回');
  assert.equal(after.hash, before.hash, '强制撤销后快照与写入前一致');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 0);

  const audits = store.db.prepare("SELECT * FROM write_audit WHERE undo_of!='' ORDER BY seq").all();
  const eventUndo = audits.filter(row => row.undo_of === eventResult.eventId);
  assert.equal(eventUndo.length, 2, '强制覆盖同时留下 skip 与 forced 两条审计');
  assert.deepEqual(eventUndo.map(row => row.result), ['skipped_conflict', 'forced']);
  assert.deepEqual(eventUndo.map(row => row.action), ['skip', 'update']);
  assert.equal(JSON.parse(eventUndo[0].old_values).title, '我手工改过的标题');
  assert.equal(JSON.parse(eventUndo[1].new_values).title, before.events[0].title);

  const summary = summarizeTaskUndo({dir, userId: 'user-a', taskId: 'task-undo-1'});
  assert.equal(summary.allUndone, true);
  assert.equal(summary.forced, 1);
  assert.match(summary.summary, /强制覆盖/);
});

test('删除的逆操作：重新插入 old_values，所有列（含时间戳）与删除前一致', async t => {
  const {dir, store} = await setup(t);
  seedEvent(store);
  const before = snapshot(store);
  const deleted = store.getEvent('seed-event-0001');
  const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: 'user-a', taskId: 'task-delete-1'});
  const outcome = await gateway.write({
    tool: 'career_recruit_bulk_write',
    sensitivity: 'auto',
    payload: {deleteId: deleted.id},
    idempotencyKey: 'idem-delete-1',
    sourceRef: SOURCE,
    execute: () => {
      store.db.prepare('DELETE FROM events WHERE id=?').run(deleted.id);
      return {changes: [{action: 'delete', entity: 'events', entityId: deleted.id, oldValues: deleted, newValues: null}], result: {}};
    }
  });
  assert.equal(store.getEvent('seed-event-0001'), null);

  const preview = previewUndo({dir, userId: 'user-a', batchId: outcome.batchId});
  assert.equal(preview.counts.ready, 1, '删除后行不存在，可直接重建');
  const undo = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId});
  assert.equal(undo.results[0].result, 'undone');
  assert.equal(undo.results[0].undoAction, 'create', '删除的逆操作是重新插入');
  const after = snapshot(store);
  assert.deepEqual(after.events, before.events, '重建要恢复所有列与时间戳');
  assert.equal(after.hash, before.hash);
});

test('删除的逆操作：行被手工重建时默认冲突，强制覆盖为旧值', async t => {
  const {dir, store} = await setup(t);
  seedEvent(store);
  const before = snapshot(store);
  const deleted = store.getEvent('seed-event-0001');
  const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: 'user-a', taskId: 'task-delete-2'});
  const outcome = await gateway.write({
    tool: 'career_recruit_bulk_write',
    sensitivity: 'auto',
    payload: {deleteId: deleted.id},
    idempotencyKey: 'idem-delete-2',
    sourceRef: SOURCE,
    execute: () => {
      store.db.prepare('DELETE FROM events WHERE id=?').run(deleted.id);
      return {changes: [{action: 'delete', entity: 'events', entityId: deleted.id, oldValues: deleted, newValues: null}], result: {}};
    }
  });
  // 手工重建同 id 但内容不同的行。
  store.db.prepare("INSERT INTO events(id,source_id,school,city,kind,title,start_at,status) VALUES(?,?,?,?,?,?,?,?)")
    .run(deleted.id, 'manual', '别的学校', '成都', '宣讲会', '手工重建的活动', '2026-12-01T09:00:00+08:00', 'active');
  const conflicted = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId});
  assert.equal(conflicted.counts.conflicts, 1);
  assert.equal(conflicted.results[0].result, 'skipped_conflict');
  assert.equal(store.getEvent(deleted.id).title, '手工重建的活动');

  const forced = await undoBatch({dir, userId: 'user-a', batchId: outcome.batchId, force: true});
  assert.equal(forced.results[0].result, 'forced');
  assert.deepEqual(snapshot(store).events, before.events, '强制撤销把重建的行覆盖回旧值');
});
test('任务级撤销：意外错误立即停止并回滚那一批，聚合计数保留已完成的批次', async t => {
  const {dir, store} = await setup(t);
  const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: 'user-a', taskId: 'task-stop'});
  const first = await gateway.write({
    tool: 'career_recruit_bulk_write', sensitivity: 'auto',
    payload: {events: [EVENT], projects: [PROJECT], source: SOURCE}, idempotencyKey: 'stop-1', sourceRef: SOURCE,
    execute: () => bulkWriteRows({store, events: [EVENT], projects: [PROJECT], source: SOURCE})
  });
  const eventId = first.result.events[0].id;
  const second = await gateway.write({
    tool: 'career_recruit_bulk_write', sensitivity: 'auto',
    payload: {project: {eventId, company: '第二家单位', title: '第二个项目'}}, idempotencyKey: 'stop-2', sourceRef: SOURCE,
    execute: () => {
      const saved = store.upsertProject({eventId, company: '第二家单位', title: '第二个项目'});
      return {changes: [{action: 'create', entity: 'event_projects', entityId: saved.id, oldValues: null, newValues: saved}]};
    }
  });
  assert.notEqual(first.batchId, second.batchId);
  // 删除项目时故意失败：撤销第二批会整体回滚并停止，不再处理第一批。
  store.db.exec("CREATE TRIGGER fail_undo_project BEFORE DELETE ON event_projects BEGIN SELECT RAISE(ABORT, 'undo unavailable'); END");
  const before = snapshot(store);
  const stopped = await undoTask({dir, userId: 'user-a', taskId: 'task-stop'});
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopped, true, '意外错误要停止后续批次');
  assert.equal(stopped.counts.failed, 1, '第二批一行失败');
  assert.equal(stopped.counts.undone, 0);
  assert.equal(stopped.batches.length, 1, '后面的批次不再处理');
  assert.deepEqual(snapshot(store), before, '失败的那一批整体回滚，不留半截撤销');
  const still = summarizeTaskUndo({dir, userId: 'user-a', taskId: 'task-stop'});
  assert.equal(still.available, true);
  assert.equal(still.undone, 0);

  store.db.exec('DROP TRIGGER fail_undo_project');
  const retried = await undoTask({dir, userId: 'user-a', taskId: 'task-stop'});
  assert.equal(retried.ok, true);
  assert.equal(retried.counts.failed, 0);
  assert.equal(retried.counts.undone, 3);
  assert.equal(retried.counts.batchesUndone, 2);
  assert.deepEqual(snapshot(store).events, []);
  assert.deepEqual(snapshot(store).projects, []);
});
