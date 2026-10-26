import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RecruitStore} from '../src/recruit/store.mjs';
import {bulkWrite} from '../src/tools/handlers/recruit.mjs';
import {ensureAuditSchema, listAuditBatches} from '../src/writes/audit-store.mjs';
import {createWriteGateway, fingerprintOf, redactPreview, uuidv7, WriteError} from '../src/writes/gateway.mjs';

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

async function openStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-write-gateway-'));
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  t.after(async () => { store.close(); await rm(dir, {recursive: true, force: true}); });
  return {dir, store};
}

// 网关单测用一张最小的业务表，避免把招聘库语义混进事务/幂等细节。
async function openRaw(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-write-raw-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  const gateway = createWriteGateway({db, domain: 'test', userId: 'user-a', actorType: 'model', actorRef: 'mock-model', taskId: 'task-1'});
  t.after(async () => { db.close(); await rm(dir, {recursive: true, force: true}); });

  const insert = (id, title = id) => () => {
    db.prepare('INSERT INTO items(id, title) VALUES(?, ?)').run(id, title);
    return [{action: 'create', entity: 'items', entityId: id, oldValues: null, newValues: {id, title}}];
  };
  const rows = table => db.prepare('SELECT COUNT(*) c FROM ' + table).get().c;
  return {db, gateway, insert, rows};
}

test('批量写入：活动与项目逐行审计、共享 batch_id、旧值/新值为整行', async t => {
  const {dir, store} = await openStore(t);
  const ctx = {taskId: 'task-1', config: {recruitDir: dir, userId: 'user-a', actorRef: 'mock-model'}};
  const first = {
    events: [{
      title: '西南财经大学2026届秋季双选会', startAt: '2026-11-05T09:00:00+08:00',
      school: '西南财经大学', city: '成都', kind: '双选会', venue: '柳林校区体育馆', sourceKey: 'swufe-2026'
    }],
    projects: [{eventIndex: 0, company: '中国银行四川省分行', title: '管理培训生', positions: '若干', applyMode: '网申'}],
    source: {sourceId: 'manual', sourceUrl: 'https://job.swufe.edu.cn/info/1', notes: '浏览器截图读取（非采集器）'},
    idempotencyKey: 'idem-1'
  };

  const one = await bulkWrite({...first}, ctx);
  assert.equal(one.status, 'ok');
  assert.equal(one.duplicate, false);
  assert.match(one.batchId, UUID7, '一个批次一个 uuidv7 批次号');
  assert.deepEqual(one.counts, {rows: 2, created: 2, updated: 0, deleted: 0, skipped: 0});

  const audits = store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
  assert.equal(audits.length, 2, '每行业务数据一条审计');
  assert.equal(new Set(audits.map(row => row.batch_id)).size, 1, '同一次调用共享 batch_id');
  assert.equal(audits[0].entity, 'events');
  assert.equal(audits[0].action, 'create');
  assert.equal(audits[0].old_values, null, '新增的旧值为空');
  const createdEvent = JSON.parse(audits[0].new_values);
  assert.equal(createdEvent.title, '西南财经大学2026届秋季双选会', '新值保存整行');
  assert.equal(createdEvent.sourceId, 'manual');
  assert.equal(createdEvent.venue, '柳林校区体育馆');
  assert.match(audits[0].event_id, UUID7, '审计事件 id 为 uuidv7');
  assert.equal(audits[0].task_id, 'task-1');
  assert.equal(audits[0].user_id, 'user-a');
  assert.equal(audits[0].idempotency_key, 'idem-1');
  assert.equal(audits[0].request_fingerprint.length, 64);
  assert.equal(audits[0].result, 'applied');
  assert.equal(audits[1].entity, 'event_projects');
  const createdProject = JSON.parse(audits[1].new_values);
  assert.equal(createdProject.company, '中国银行四川省分行');
  assert.equal(createdProject.eventId, createdEvent.id);

  // 同键同参数重放：不新增行、不新增审计，返回首次结果并标 duplicate。
  const replay = await bulkWrite({...first}, ctx);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'ok');
  assert.equal(replay.batchId, one.batchId);
  assert.deepEqual(replay.counts, one.counts, '重放返回首次结果');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, 2, '重放不新增审计');

  // 换一个幂等键、同一稳定身份（sourceKey + title/startAt）：更新而不是新增。
  const two = await bulkWrite({
    events: [{...first.events[0], title: '西南财经大学2026届秋季双选会（更新）'}],
    projects: [
      {...first.projects[0], positions: '管理培训生 20 人'},
      {eventId: createdEvent.id, company: '中国农业银行四川省分行', title: '综合业务岗'}
    ],
    source: first.source,
    idempotencyKey: 'idem-2'
  }, ctx);
  assert.equal(two.counts.created, 1, '新项目新增 1 行');
  assert.equal(two.counts.updated, 2, '活动与同身份项目按更新处理');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, 1, '稳定身份不新增活动');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 2);
  assert.notEqual(two.batchId, one.batchId, '每次工具调用一个批次');

  const all = store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
  assert.equal(all.length, 5);
  const updateAudit = all[2];
  assert.equal(updateAudit.action, 'update');
  assert.equal(JSON.parse(updateAudit.old_values).title, '西南财经大学2026届秋季双选会');
  assert.equal(JSON.parse(updateAudit.new_values).title, '西南财经大学2026届秋季双选会（更新）');
  assert.equal(new Set([all[2].batch_id, all[3].batch_id, all[4].batch_id]).size, 1);

  // 审计查询按任务与批次分组，返回解析后的旧值/新值与计数。
  const batches = listAuditBatches(store.db, {userId: 'user-a', taskId: 'task-1', domain: 'recruit'});
  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchId, two.batchId, '批次新→旧');
  assert.equal(batches[0].counts.total, 3);
  assert.equal(batches[0].counts.create, 1);
  assert.equal(batches[0].counts.update, 2);
  assert.equal(batches[1].rows[0].oldValues, null);
  assert.equal(batches[1].rows[0].newValues.title, '西南财经大学2026届秋季双选会');

  const only = listAuditBatches(store.db, {userId: 'user-a', batchId: one.batchId, domain: 'recruit'});
  assert.equal(only.length, 1);
  assert.equal(only[0].rows.length, 2);
  assert.equal(only[0].taskId, 'task-1');
  assert.equal(listAuditBatches(store.db, {userId: 'other-user', domain: 'recruit'}).length, 0, '审计只属于本人');
});

test('幂等：缺键 400、同键不同指纹 422、进行中 409、过期按新写入、作用域 (用户, 工具, 键)', async t => {
  const {db, gateway, insert, rows} = await openRaw(t);

  await assert.rejects(
    () => gateway.write({tool: 't', payload: {a: 1}, execute: insert('i0')}),
    error => error instanceof WriteError && error.status === 400 && error.code === 'MISSING_IDEMPOTENCY_KEY'
  );
  assert.equal(rows('items'), 0);

  const first = await gateway.write({tool: 't', payload: {a: 1}, idempotencyKey: 'k1', execute: insert('i1')});
  assert.equal(first.status, 'applied');
  assert.equal(first.duplicate, false);
  assert.equal(first.counts.rows, 1);
  assert.equal(rows('items'), 1);

  const replay = await gateway.write({tool: 't', payload: {a: 1}, idempotencyKey: 'k1', execute: insert('i2')});
  assert.equal(replay.duplicate, true);
  assert.equal(replay.batchId, first.batchId);
  assert.equal(rows('items'), 1, '重放不执行第二次业务写入');

  await assert.rejects(
    () => gateway.write({tool: 't', payload: {a: 2}, idempotencyKey: 'k1', execute: insert('i3')}),
    error => error.status === 422 && error.code === 'IDEMPOTENCY_KEY_CONFLICT'
  );

  const now = Date.now();
  const future = new Date(now + 60000).toISOString();
  const past = new Date(now - 60000).toISOString();
  const insertIdem = (key, fingerprint, status, expiresAt) => db.prepare(
    `INSERT INTO idempotency(user_id,tool,key,fingerprint,status,response_json,confirm_id,audit_batch_id,created_at,expires_at)
     VALUES(?,?,?,?,?,'','','',?,?)`
  ).run('user-a', 't', key, fingerprint, status, new Date(now).toISOString(), expiresAt);

  insertIdem('k2', fingerprintOf({a: 3}), 'in_progress', future);
  await assert.rejects(
    () => gateway.write({tool: 't', payload: {a: 3}, idempotencyKey: 'k2', execute: insert('i4')}),
    error => error.status === 409 && error.code === 'IDEMPOTENCY_IN_PROGRESS'
  );

  insertIdem('k3', fingerprintOf({a: 4}), 'completed', past);
  const afterExpiry = await gateway.write({tool: 't', payload: {a: 4}, idempotencyKey: 'k3', execute: insert('i5')});
  assert.equal(afterExpiry.duplicate, false, '过期键按新写入处理');

  const sameKeyOtherTool = await gateway.write({tool: 'other', payload: {a: 1}, idempotencyKey: 'k1', execute: insert('i6')});
  assert.equal(sameKeyOtherTool.duplicate, false, '键作用域含工具');
  const otherUser = createWriteGateway({db, domain: 'test', userId: 'user-b', actorType: 'model', taskId: 'task-2'});
  const sameKeyOtherUser = await otherUser.write({tool: 't', payload: {a: 1}, idempotencyKey: 'k1', execute: insert('i7')});
  assert.equal(sameKeyOtherUser.duplicate, false, '键作用域含用户');

  const created = db.prepare('SELECT * FROM idempotency WHERE user_id=? AND tool=? AND key=?').get('user-a', 't', 'k1');
  assert.equal(created.status, 'completed');
  assert.equal(created.audit_batch_id, first.batchId);
  assert.equal(Date.parse(created.expires_at) - Date.parse(created.created_at), SEVEN_DAYS, '幂等行保留 7 天');
});

test('fail closed：审计写失败时业务数据不落库（SQL 触发器）', async t => {
  const {db, gateway, rows} = await openRaw(t);
  ensureAuditSchema(db, 'test');
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON write_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");

  await assert.rejects(
    () => gateway.write({
      tool: 't', payload: {a: 1}, idempotencyKey: 'k1',
      execute: () => {
        db.prepare('INSERT INTO items(id, title) VALUES(?, ?)').run('i1', 'i1');
        return [{action: 'create', entity: 'items', entityId: 'i1', oldValues: null, newValues: {id: 'i1', title: 'i1'}}];
      }
    }),
    error => error.code === 'WRITE_FAILED' && error.status === 500
  );
  assert.equal(rows('items'), 0, '审计失败必须整体回滚');
  assert.equal(rows('write_audit'), 0);
  assert.equal(rows('idempotency'), 0, '幂等完成标记也随事务回滚');
});

test('单条审计事件超过 256KB 拒绝该次写入并回滚', async t => {
  const {gateway, rows} = await openRaw(t);
  const huge = {id: 'i1', note: 'x'.repeat(300 * 1024)};
  await assert.rejects(
    () => gateway.write({
      tool: 't', payload: {}, idempotencyKey: 'k1',
      execute: () => {
        return [{action: 'create', entity: 'items', entityId: 'i1', oldValues: null, newValues: huge}];
      }
    }),
    error => error.code === 'AUDIT_EVENT_TOO_LARGE' && error.status === 413
  );
  assert.equal(rows('items'), 0);
  assert.equal(rows('write_audit'), 0);
});

test('敏感写入：未确认返回 confirm_required 与脱敏预览，确认后原子消费并写审计', async t => {
  const {db, gateway, insert, rows} = await openRaw(t);
  const payload = {profile: {nickname: '小明', phone: '13800138000', email: 'ming@example.com', wechat: 'wx_ming'}};
  const preview = redactPreview(payload.profile);
  assert.equal(preview.phone, '***');
  assert.equal(preview.email, '***');
  assert.equal(preview.wechat, '***');
  assert.equal(preview.nickname, '小明', '非敏感字段保留可读');

  const request = {tool: 'profile_write', sensitivity: 'sensitive', payload, idempotencyKey: 's1', preview: payload.profile, execute: insert('p1')};
  const pending = await gateway.write({...request});
  assert.equal(pending.status, 'confirm_required');
  assert.match(pending.confirmId, UUID7);
  assert.ok(pending.expiresAt);
  assert.ok(!JSON.stringify(pending.preview).includes('13800138000'), '预览必须脱敏');
  assert.ok(!JSON.stringify(pending.preview).includes('ming@example.com'));
  assert.equal(rows('items'), 0, '未确认不落库');

  const stored = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
  assert.equal(stored.decision, 'pending');
  assert.equal(stored.idempotency_key, 's1');
  assert.equal(Date.parse(stored.expires_at) - Date.parse(stored.created_at), 10 * 60 * 1000, '确认 10 分钟过期');
  assert.ok(!stored.preview_summary.includes('13800138000'));

  const again = await gateway.write({...request});
  assert.equal(again.confirmId, pending.confirmId, '同键同指纹重放同一确认');

  // 模型自己把 confirm_id 填回来不算用户确认。
  const notApproved = await gateway.write({...request, confirmId: pending.confirmId});
  assert.equal(notApproved.status, 'confirm_required');
  assert.equal(rows('items'), 0);

  // #30 的确认接口走 approveConfirmation：同一个事务里消费确认、写业务行、写审计。
  const applied = await gateway.write({...request, confirmId: pending.confirmId, approveConfirmation: true});
  assert.equal(applied.status, 'applied');
  assert.equal(applied.confirmed, true);
  assert.equal(rows('items'), 1);
  const audit = db.prepare('SELECT * FROM write_audit ORDER BY seq DESC LIMIT 1').get();
  assert.equal(audit.confirmed, 1);
  assert.equal(audit.confirm_id, pending.confirmId);
  const consumed = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
  assert.equal(consumed.decision, 'accepted');
  assert.ok(consumed.consumed_at);
  assert.ok(consumed.executed_at);

  await assert.rejects(
    () => gateway.write({
      ...request, idempotencyKey: 's2', confirmationKey: 's1', confirmId: pending.confirmId, approveConfirmation: true,
      execute: insert('p2')
    }),
    error => error.status === 409 && error.code === 'CONFIRMATION_CONSUMED'
  );

  // 参数（指纹）变化要重新确认。
  const other = await gateway.write({...request, payload: {profile: {nickname: '小红'}}, idempotencyKey: 's3'});
  assert.equal(other.status, 'confirm_required');
  assert.notEqual(other.confirmId, pending.confirmId);
  await assert.rejects(
    () => gateway.write({
      ...request, idempotencyKey: 's4', confirmationKey: 's3', confirmId: other.confirmId, approveConfirmation: true
    }),
    error => error.status === 422 && error.code === 'CONFIRMATION_MISMATCH'
  );

  // 过期确认返回 410。
  db.prepare('UPDATE confirmations SET expires_at=? WHERE confirm_id=?').run(new Date(Date.now() - 1000).toISOString(), other.confirmId);
  await assert.rejects(
    () => gateway.write({
      ...request, payload: {profile: {nickname: '小红'}}, idempotencyKey: 's3', confirmId: other.confirmId, approveConfirmation: true
    }),
    error => error.status === 410 && error.code === 'CONFIRMATION_EXPIRED'
  );
});

test('uuidv7：符合 RFC 9562 布局且按时间有序', () => {
  const early = uuidv7(Date.parse('2026-10-26T00:00:00.000Z'));
  const late = uuidv7(Date.parse('2026-10-26T00:00:01.000Z'));
  assert.match(early, UUID7);
  assert.match(late, UUID7);
  assert.ok(early < late, '时间前缀保证可排序');
});
