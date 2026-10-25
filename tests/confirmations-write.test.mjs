import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProfileDb, listProfileFacts} from '../src/profile/store.mjs';
import {profileWrite} from '../src/tools/handlers/profile.mjs';
import {listTools} from '../src/tools/registry.mjs';
import {acceptConfirmation, listConfirmations, rejectConfirmation} from '../src/writes/confirmations.mjs';

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function openCtx(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-confirm-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const ctx = (extra = {}) => ({
    taskId: 'task-1',
    config: {dataDir: dir, userId: 'user-a', taskId: 'task-1', actorRef: 'mock-model', ...extra}
  });
  const readFacts = () => {
    const db = openProfileDb(join(dir, 'profile.db'));
    try { return listProfileFacts(db, 'user-a'); } finally { db.close(); }
  };
  return {dir, ctx, readFacts};
}

test('敏感画像写入：注册为 sensitive/profile，未确认不落库并返回脱敏预览', async t => {
  const {dir, ctx, readFacts} = await openCtx(t);
  const tool = listTools().find(item => item.name === 'career_profile_write');
  assert.ok(tool, '注册表要有长期画像写入工具');
  assert.equal(tool.permission, 'write');
  assert.equal(tool.sensitivity, 'sensitive');
  assert.equal(tool.writeDomain, 'profile');

  const facts = [
    {key: '手机', value: '13800138000'},
    {key: '邮箱', value: 'ming@example.com'},
    {key: '城市偏好', value: '成都'},
    {key: '目标岗位', value: '产品经理'}
  ];
  const pending = await profileWrite({facts, idempotencyKey: 'profile-1'}, ctx());
  assert.equal(pending.status, 'confirm_required');
  assert.equal(pending.code, 'NEEDS_CONFIRMATION');
  assert.match(pending.confirmId, UUID7);
  assert.ok(Date.parse(pending.expiresAt) - Date.now() > 9 * 60 * 1000, '确认 10 分钟有效');

  const preview = JSON.stringify(pending.preview);
  assert.ok(!preview.includes('13800138000'), '预览不能带手机号');
  assert.ok(!preview.includes('ming@example.com'), '预览不能带邮箱');
  assert.match(preview, /城市偏好/, '非敏感字段保留可读键名');
  assert.match(preview, /成都/, '非敏感字段保留可读值');

  assert.equal(readFacts().length, 0, '未确认前没有业务行');

  const db = openProfileDb(join(dir, 'profile.db'));
  const stored = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
  db.close();
  assert.equal(stored.decision, 'pending');
  assert.equal(stored.task_id, 'task-1', '确认要绑定任务，供任务卡按任务取待确认');
  assert.equal(stored.idempotency_key, 'profile-1');
  assert.ok(stored.payload_json.includes('13800138000'), 'payload 保存原始调用参数，接受时按原参数重放');
  assert.equal(Date.parse(stored.expires_at) - Date.parse(stored.created_at), 10 * 60 * 1000);

  const listed = listConfirmations({dir, userId: 'user-a', taskId: 'task-1'});
  assert.equal(listed.confirmations.length, 1);
  assert.equal(listed.confirmations[0].confirmId, pending.confirmId);
  assert.equal(listed.confirmations[0].taskId, 'task-1');
  assert.equal(listed.confirmations[0].tool, 'career_profile_write');
  assert.equal(listed.confirmations[0].decision, 'pending');
  assert.equal(listed.counts.pending, 1);
  assert.ok(!JSON.stringify(listed.confirmations[0].preview).includes('13800138000'), '列表预览同样脱敏');
  assert.equal(listConfirmations({dir, userId: 'user-b'}).confirmations.length, 0, '确认只属于本人');

  // 同键同参数重放同一个确认，不会生成第二条。
  const again = await profileWrite({facts, idempotencyKey: 'profile-1'}, ctx());
  assert.equal(again.confirmId, pending.confirmId);
  assert.equal(listConfirmations({dir, userId: 'user-a'}).confirmations.length, 1);
});
test('接受确认：同一事务落库+审计+消费+原幂等键完成；重复接受幂等', async t => {
  const {dir, ctx, readFacts} = await openCtx(t);
  const facts = [{key: '届别', value: '2027 届'}, {key: '城市偏好', value: '成都'}];
  const pending = await profileWrite({facts, idempotencyKey: 'profile-accept-1'}, ctx());

  const accepted = await acceptConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId});
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'applied');
  assert.equal(accepted.duplicate, false);
  assert.match(accepted.batchId, UUID7);
  assert.deepEqual(accepted.counts, {rows: 2, created: 2, updated: 0, deleted: 0, skipped: 0});
  assert.equal(accepted.confirmed, true);
  assert.ok(accepted.acceptedAt);

  const stored = readFacts();
  assert.equal(stored.length, 2, '接受后业务行落库');
  assert.equal(stored.find(fact => fact.key === '城市偏好').value, '成都');

  const db = openProfileDb(join(dir, 'profile.db'));
  try {
    const audits = db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
    assert.equal(audits.length, 2, '业务行与审计 1:1');
    assert.equal(audits.every(row => row.confirmed === 1), true, '确认写入的审计标 confirmed=1');
    assert.equal(audits[0].confirm_id, pending.confirmId);
    assert.equal(audits[0].actor_type, 'user', '接受动作以用户身份执行');
    assert.equal(audits[0].batch_id, accepted.batchId);
    assert.equal(JSON.parse(audits[0].new_values).value, '2027 届');

    const row = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
    assert.equal(row.decision, 'accepted');
    assert.ok(row.consumed_at, '确认标记已消费');
    assert.ok(row.executed_at);
    const original = db.prepare('SELECT * FROM idempotency WHERE user_id=? AND tool=? AND key=?').get('user-a', 'career_profile_write', 'profile-accept-1');
    assert.equal(original.status, 'completed', '原幂等键标完成，重试原请求不会重复写');
    assert.equal(original.audit_batch_id, accepted.batchId);
    const keys = db.prepare('SELECT key, status FROM idempotency WHERE user_id=? AND tool=?').all('user-a', 'career_profile_write');
    assert.equal(keys.length, 2, '接受用一条新的服务端幂等键，原键也保留');
    assert.ok(keys.every(item => item.status === 'completed'));
    const newKey = keys.find(item => item.key !== 'profile-accept-1');
    assert.match(newKey.key, UUID7, '新幂等键由服务端生成');

    const again = await acceptConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId});
    assert.equal(again.duplicate, true, '重复接受幂等');
    assert.equal(again.batchId, accepted.batchId, '重复接受返回第一次结果');
    assert.equal(readFacts().length, 2, '重复接受不第二次写入');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, 2, '重复接受不新增审计');
  } finally { db.close(); }
});

test('拒绝确认：留 rejected 记录、不落库；拒绝后再接受 403', async t => {
  const {dir, ctx, readFacts} = await openCtx(t);
  const pending = await profileWrite({facts: [{key: '期望城市', value: '上海'}], idempotencyKey: 'profile-reject-1'}, ctx());
  const rejected = await rejectConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId, reason: '不想写这一条'});
  assert.equal(rejected.ok, true);
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.duplicate, false);
  assert.ok(rejected.rejectedAt);
  assert.equal(readFacts().length, 0, '拒绝不落业务行');

  const db = openProfileDb(join(dir, 'profile.db'));
  try {
    const row = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
    assert.equal(row.decision, 'rejected');
    assert.equal(row.decision_reason, '不想写这一条');
    assert.ok(row.executed_at, '拒绝也记录处理时间');
    assert.equal(row.consumed_at, null, '拒绝不是消费');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, 0, '拒绝不写审计');
  } finally { db.close(); }

  await assert.rejects(
    () => acceptConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId}),
    error => error.name === 'WriteError' && error.status === 403 && error.code === 'CONFIRMATION_REJECTED'
  );
  const twice = await rejectConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId});
  assert.equal(twice.duplicate, true, '重复拒绝幂等');
});

test('确认边界：过期 410、参数变化 422、已消费 409、跨用户 404', async t => {
  const {dir, ctx, readFacts} = await openCtx(t);

  const expired = await profileWrite({facts: [{key: '专业', value: '金融'}], idempotencyKey: 'profile-edge-1'}, ctx());
  const db = openProfileDb(join(dir, 'profile.db'));
  db.prepare('UPDATE confirmations SET expires_at=? WHERE confirm_id=?').run(new Date(Date.now() - 1000).toISOString(), expired.confirmId);
  await assert.rejects(
    () => acceptConfirmation({dir, userId: 'user-a', confirmId: expired.confirmId}),
    error => error.status === 410 && error.code === 'CONFIRMATION_EXPIRED'
  );

  const tampered = await profileWrite({facts: [{key: '技能', value: 'SQL'}], idempotencyKey: 'profile-edge-2'}, ctx());
  db.prepare('UPDATE confirmations SET payload_json=? WHERE confirm_id=?')
    .run(JSON.stringify({facts: [{key: '技能', value: 'Python'}]}), tampered.confirmId);
  await assert.rejects(
    () => acceptConfirmation({dir, userId: 'user-a', confirmId: tampered.confirmId}),
    error => error.status === 422 && error.code === 'CONFIRMATION_MISMATCH'
  );

  const consumed = await profileWrite({facts: [{key: '语言', value: '英语'}], idempotencyKey: 'profile-edge-3'}, ctx());
  db.prepare("UPDATE confirmations SET consumed_at=? WHERE confirm_id=?").run(new Date().toISOString(), consumed.confirmId);
  await assert.rejects(
    () => acceptConfirmation({dir, userId: 'user-a', confirmId: consumed.confirmId}),
    error => error.status === 409 && error.code === 'CONFIRMATION_CONSUMED'
  );

  const foreign = await profileWrite({facts: [{key: '证书', value: 'CFA'}], idempotencyKey: 'profile-edge-4'}, ctx());
  await assert.rejects(
    () => acceptConfirmation({dir, userId: 'user-b', confirmId: foreign.confirmId}),
    error => error.status === 404 && error.code === 'CONFIRMATION_NOT_FOUND'
  );
  await assert.rejects(
    () => rejectConfirmation({dir, userId: 'user-b', confirmId: foreign.confirmId}),
    error => error.status === 404 && error.code === 'CONFIRMATION_NOT_FOUND'
  );
  db.close();
  assert.equal(readFacts().length, 0, '以上边界都没有落业务行');
});

test('接受确认 fail closed：审计写失败时业务行与确认状态一起回滚', async t => {
  const {dir, ctx, readFacts} = await openCtx(t);
  const pending = await profileWrite({facts: [{key: '期望岗位', value: '产品经理'}], idempotencyKey: 'profile-fail-1'}, ctx());
  const db = openProfileDb(join(dir, 'profile.db'));
  try {
    db.exec("CREATE TRIGGER fail_confirm_audit BEFORE INSERT ON write_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await assert.rejects(
      () => acceptConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId}),
      error => error.name === 'WriteError' && error.status === 500
    );
    assert.equal(readFacts().length, 0, '审计失败必须整体回滚业务行');
    const row = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(pending.confirmId);
    assert.equal(row.decision, 'pending', '确认没有被消费');
    assert.equal(row.consumed_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM idempotency').get().c, 1, '只剩发起确认时的 pending 幂等行');
  } finally { db.close(); }
});
