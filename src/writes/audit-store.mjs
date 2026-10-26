// 自动写入审计存储：四张表（write_audit / idempotency / confirmations / audit_meta）与查询。
// 与业务数据同库；本模块只认拿到的 DatabaseSync，不自己开连接，方便写网关在同一个事务里同时写业务行与审计行。
export const AUDIT_TABLES = ['write_audit', 'idempotency', 'confirmations', 'audit_meta'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS write_audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_ref TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_values TEXT,
  new_values TEXT,
  source_ref TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  confirm_id TEXT NOT NULL DEFAULT '',
  confirmed INTEGER NOT NULL DEFAULT 0,
  undo_of TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'applied',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_write_audit_batch ON write_audit(batch_id);
CREATE INDEX IF NOT EXISTS idx_write_audit_task ON write_audit(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_write_audit_user ON write_audit(user_id, seq);

CREATE TABLE IF NOT EXISTS idempotency(
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT NOT NULL DEFAULT '',
  confirm_id TEXT NOT NULL DEFAULT '',
  audit_batch_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id, tool, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency(expires_at);

CREATE TABLE IF NOT EXISTS confirmations(
  confirm_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  preview_summary TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT '',
  actor_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_confirmations_user ON confirmations(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_meta(
  domain TEXT PRIMARY KEY,
  last_cleared_at TEXT,
  updated_at TEXT
);
`;

// 旧库迁移：#29 建过 confirmations，但确认要能按原参数重放、按任务卡取，补齐后加的列。
const CONFIRMATION_COLUMNS = [
  ['payload_json', "TEXT NOT NULL DEFAULT ''"],
  ['task_id', "TEXT NOT NULL DEFAULT ''"],
  ['decision_reason', "TEXT NOT NULL DEFAULT ''"],
  // #38：入站转发发起的敏感写，确认后落库的审计要能认出 forwarded_client + client id。
  ['actor_type', "TEXT NOT NULL DEFAULT ''"],
  ['actor_ref', "TEXT NOT NULL DEFAULT ''"]
];

export function ensureConfirmationColumns(db) {
  const names = new Set(db.prepare('PRAGMA table_info(confirmations)').all().map(row => row.name));
  for (const [name, definition] of CONFIRMATION_COLUMNS) {
    if (!names.has(name)) db.exec('ALTER TABLE confirmations ADD COLUMN ' + name + ' ' + definition);
  }
}

// 建表幂等：网关构造时调用一次；业务库与审计库是同一个文件。
export function ensureAuditSchema(db, domain = '') {
  db.exec(SCHEMA);
  ensureConfirmationColumns(db);
  if (domain) {
    db.prepare('INSERT INTO audit_meta(domain, last_cleared_at, updated_at) VALUES(?, NULL, ?) ON CONFLICT(domain) DO NOTHING')
      .run(String(domain), new Date().toISOString());
  }
}

// 只读路径用：库还没建过审计表时不要顺手建表（手动写入不能产生任何审计痕迹）。
export function hasAuditSchema(db) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='write_audit'").get();
  } catch {
    return false;
  }
}

export function readConfirmation(db, userId, confirmId) {
  if (!confirmId) return null;
  const row = db.prepare('SELECT * FROM confirmations WHERE confirm_id=? AND user_id=?').get(String(confirmId), String(userId));
  return row || null;
}

// 一条业务行一条审计行；由写网关在事务内调用。
export function insertAuditRow(db, row) {
  db.prepare(`INSERT INTO write_audit(
    event_id, occurred_at, user_id, actor_type, actor_ref, tool, task_id, batch_id, action, entity, entity_id,
    old_values, new_values, source_ref, idempotency_key, request_fingerprint, confirm_id, confirmed, undo_of, result, note
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.eventId, row.occurredAt, row.userId, row.actorType, row.actorRef || '', row.tool, row.taskId || '', row.batchId,
    row.action, row.entity, row.entityId,
    row.oldValues === undefined ? null : row.oldValues,
    row.newValues === undefined ? null : row.newValues,
    row.sourceRef || '', row.idempotencyKey, row.requestFingerprint, row.confirmId || '',
    row.confirmed ? 1 : 0, row.undoOf || '', row.result || 'applied', row.note || ''
  );
}

function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try { return JSON.parse(text); } catch { return text; }
}

function projectRow(row) {
  return {
    seq: Number(row.seq),
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    userId: row.user_id,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    tool: row.tool,
    taskId: row.task_id,
    batchId: row.batch_id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    oldValues: parseJson(row.old_values),
    newValues: parseJson(row.new_values),
    sourceRef: parseJson(row.source_ref),
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    confirmId: row.confirm_id || '',
    confirmed: !!row.confirmed,
    undoOf: row.undo_of || '',
    result: row.result || 'applied',
    note: row.note || ''
  };
}

// 按批次分组，批次新→旧，行内按 seq 升序；limit 限制批次数（默认 50，最多 200）。
export function listAuditBatches(db, {userId, taskId = '', batchId = '', limit = 50, domain = ''} = {}) {
  if (!userId) return [];
  const filters = ['user_id = ?'];
  const filterArgs = [String(userId)];
  if (taskId) { filters.push('task_id = ?'); filterArgs.push(String(taskId)); }
  if (batchId) { filters.push('batch_id = ?'); filterArgs.push(String(batchId)); }
  const where = filters.join(' AND ');
  let batchIds;
  if (batchId) {
    batchIds = [String(batchId)];
  } else {
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    batchIds = db.prepare(`SELECT batch_id FROM write_audit WHERE ${where} GROUP BY batch_id ORDER BY MAX(seq) DESC LIMIT ?`)
      .all(...filterArgs, max).map(row => row.batch_id);
  }
  if (!batchIds.length) return [];
  const marks = batchIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM write_audit WHERE user_id = ? AND batch_id IN (${marks}) ORDER BY seq ASC`)
    .all(String(userId), ...batchIds);
  const byBatch = new Map(batchIds.map(id => [id, []]));
  for (const row of rows) {
    if (!byBatch.has(row.batch_id)) byBatch.set(row.batch_id, []);
    byBatch.get(row.batch_id).push(projectRow(row));
  }
  const batches = [];
  for (const id of batchIds) {
    const items = byBatch.get(id) || [];
    if (!items.length) continue;
    const first = items[0];
    const counts = {total: items.length, create: 0, update: 0, delete: 0, skip: 0};
    for (const item of items) if (counts[item.action] !== undefined) counts[item.action] += 1;
    batches.push({
      batchId: id,
      taskId: first.taskId,
      tool: first.tool,
      actorType: first.actorType,
      actorRef: first.actorRef,
      domain: domain || '',
      occurredAt: first.occurredAt,
      counts,
      rows: items
    });
  }
  // 传入 batchId 时保持单批；否则按批内最大 seq 新→旧。
  if (!batchId) batches.sort((a, b) => (b.rows.at(-1)?.seq || 0) - (a.rows.at(-1)?.seq || 0));
  return batches;
}
