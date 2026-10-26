// 敏感写入确认：列出待确认、接受（原子消费并按原参数重放）、拒绝（留记录不落库）。
// 确认记录与审计同库；身份只来自调用方传入的 userId，不读请求体。
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {getTool} from '../tools/registry.mjs';
import {readConfirmation} from './audit-store.mjs';
import {WRITE_DOMAINS, domainEntry} from './domains.mjs';
import {WRITE_EXECUTORS} from './executors.mjs';
import {createWriteGateway, fingerprintOf, uuidv7, WriteError} from './gateway.mjs';

const EMPTY_COUNTS = {rows: 0, created: 0, updated: 0, deleted: 0, skipped: 0};

function parsePreview(summary) {
  try { return JSON.parse(summary); } catch { return summary; }
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function projectConfirmation(row, domain, nowIso) {
  return {
    confirmId: row.confirm_id,
    taskId: row.task_id || '',
    tool: row.tool,
    domain,
    entity: row.entity || '',
    entityId: row.entity_id || '',
    action: row.action || '',
    preview: parsePreview(row.preview_summary),
    previewSummary: row.preview_summary || '',
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    // 发起来源：手动/任务写入是 user，入站转发是 forwarded_client + client id（#38）。
    actorType: row.actor_type || '',
    actorRef: row.actor_ref || '',
    decision: row.decision || 'pending',
    consumedAt: row.consumed_at || '',
    executedAt: row.executed_at || '',
    reason: row.decision_reason || '',
    expired: String(row.expires_at || '') <= String(nowIso || new Date().toISOString())
  };
}

function hasConfirmationsTable(db) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='confirmations'").get();
  } catch {
    return false;
  }
}

function openDomainDb(dir, file) {
  const path = join(String(dir), file);
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// 只读：不建库、不建表；库还没有确认表时直接跳过。
export function listConfirmations({dir, userId, taskId = '', state = 'pending', limit = 50, now = new Date()} = {}) {
  if (!dir || !userId) return {confirmations: [], counts: {total: 0, pending: 0, accepted: 0, rejected: 0, expired: 0}};
  const nowIso = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  const all = [];
  for (const entry of WRITE_DOMAINS) {
    let db = null;
    try {
      db = openDomainDb(dir, entry.file);
      if (!db || !hasConfirmationsTable(db)) continue;
      const rows = db.prepare('SELECT * FROM confirmations WHERE user_id=? ORDER BY created_at DESC').all(String(userId));
      for (const row of rows) {
        if (taskId && String(row.task_id || '') !== String(taskId)) continue;
        all.push(projectConfirmation(row, entry.domain, nowIso));
      }
    } catch {
      // 单个库读不出来不影响其它域；不伪造确认记录。
      continue;
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const counts = {total: all.length, pending: 0, accepted: 0, rejected: 0, expired: 0};
  for (const item of all) {
    if (item.decision === 'rejected') counts.rejected += 1;
    else if (item.decision === 'accepted') counts.accepted += 1;
    else if (item.expired || item.consumedAt) counts.expired += 1;
    else counts.pending += 1;
  }
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const list = state === 'all'
    ? all.slice(0, capped)
    : all.filter(item => item.decision === 'pending' && !item.expired && !item.consumedAt).slice(0, capped);
  return {confirmations: list, counts};
}

// 按确认 id 找到所属域与数据库连接；调用方负责关闭 db。
function findConfirmation(dir, userId, confirmId) {
  if (!dir || !userId || !confirmId) return null;
  for (const entry of WRITE_DOMAINS) {
    let db = null;
    try {
      db = openDomainDb(dir, entry.file);
      if (!db || !hasConfirmationsTable(db)) { try { db?.close(); } catch { /* 已关闭 */ } continue; }
      const row = readConfirmation(db, userId, confirmId);
      if (row) return {entry, db, row};
      db.close();
    } catch {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  return null;
}

function replayAccepted(db, row) {
  const stored = db.prepare('SELECT * FROM idempotency WHERE user_id=? AND tool=? AND key=?').get(row.user_id, row.tool, row.idempotency_key);
  const response = parseJson(stored?.response_json) || {};
  return {
    ok: true,
    confirmId: row.confirm_id,
    taskId: row.task_id || '',
    status: 'applied',
    duplicate: true,
    batchId: response.batchId || stored?.audit_batch_id || '',
    idempotencyKey: row.idempotency_key,
    counts: response.counts || {...EMPTY_COUNTS},
    result: response.result ?? null,
    confirmed: true,
    acceptedAt: row.executed_at || row.consumed_at || ''
  };
}

// 接受确认：校验归属/有效期/参数指纹后，交给写网关在一个 BEGIN IMMEDIATE 事务里
// 消费确认 + 按原参数写业务行 + 写审计 + 完成新幂等键与原幂等键。
export async function acceptConfirmation({dir, userId, confirmId, now = new Date()} = {}) {
  const found = findConfirmation(dir, userId, String(confirmId || '').trim());
  if (!found) throw new WriteError('CONFIRMATION_NOT_FOUND', '找不到这条确认记录。', 404);
  const {entry, db, row} = found;
  try {
    if (row.consumed_at) {
      if (row.decision === 'accepted') return replayAccepted(db, row);
      throw new WriteError('CONFIRMATION_CONSUMED', '这次确认已经被处理过；请重新发起写入。', 409);
    }
    if (row.decision === 'rejected') throw new WriteError('CONFIRMATION_REJECTED', '你已经拒绝过这次写入；如需写入请重新发起。', 403);
    const nowIso = new Date(now instanceof Date ? now.getTime() : now).toISOString();
    if (String(row.expires_at || '') <= nowIso) {
      // 带上任务 id：接口层据此把停在待确认的任务收尾为失败，不让过期确认一直占着徽标。
      throw new WriteError('CONFIRMATION_EXPIRED', '这次确认已过期（10 分钟），请重新发起写入。', 410, {taskId: row.task_id || ''});
    }

    const payload = parseJson(row.payload_json);
    if (!payload || typeof payload !== 'object') {
      throw new WriteError('CONFIRMATION_MISMATCH', '这条确认没有保存可重放的参数，请重新发起写入。', 422);
    }
    // 参数与指纹必须一致：确认后台被改动过就不能再执行，必须重新发起并确认。
    if (fingerprintOf(payload) !== row.fingerprint) {
      throw new WriteError('CONFIRMATION_MISMATCH', '确认对应的工具或参数已变化，请重新发起写入并确认。', 422);
    }
    const tool = getTool(row.tool);
    const domain = domainEntry(row.tool ? tool?.writeDomain : '');
    if (!tool || tool.sensitivity !== 'sensitive' || !domain || domain.domain !== entry.domain) {
      throw new WriteError('CONFIRMATION_MISMATCH', '确认对应的工具或写入域已变化，请重新发起写入。', 422);
    }
    const execute = WRITE_EXECUTORS[row.tool];
    if (typeof execute !== 'function') {
      throw new WriteError('CONFIRMATION_MISMATCH', '这条确认对应的写工具已不可用，请重新发起写入。', 422);
    }

    const gateway = createWriteGateway({
      db, domain: entry.domain, userId,
      // 入站转发发起的确认保留原发起来源；普通确认仍是「用户点了接受」。
      actorType: row.actor_type || 'user',
      actorRef: row.actor_ref || 'confirmation',
      taskId: row.task_id || ''
    });
    const outcome = await gateway.write({
      tool: row.tool,
      sensitivity: 'sensitive',
      payload,
      // 接受时用服务端新生成的幂等键执行；confirmationKey 指向发起确认时的原键。
      idempotencyKey: uuidv7(),
      confirmationKey: row.idempotency_key,
      confirmId: row.confirm_id,
      approveConfirmation: true,
      sourceRef: parseJson(row.source_ref),
      entity: row.entity || '',
      entityId: row.entity_id || '',
      action: row.action || '',
      execute: ({db: transaction}) => execute({db: transaction, userId, payload, taskId: row.task_id || '', now})
    });
    const updated = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(row.confirm_id);
    return {
      ok: true,
      confirmId: row.confirm_id,
      taskId: row.task_id || '',
      status: 'applied',
      duplicate: !!outcome.duplicate,
      batchId: outcome.batchId,
      counts: outcome.counts,
      result: outcome.result ?? null,
      confirmed: true,
      acceptedAt: updated?.executed_at || nowIso
    };
  } catch (error) {
    // 并发接受：另一个请求已经在事务里消费了这条确认；重新读一次按幂等返回第一次结果。
    if (error instanceof WriteError && error.code === 'CONFIRMATION_CONSUMED') {
      const fresh = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(row.confirm_id);
      if (fresh && fresh.decision === 'accepted' && fresh.consumed_at) return replayAccepted(db, fresh);
    }
    throw error;
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
}

// 拒绝确认：只写 decision/executed_at（与可选原因），不落业务行、不写审计；记录永久保留。
export async function rejectConfirmation({dir, userId, confirmId, reason = '', now = new Date()} = {}) {
  const found = findConfirmation(dir, userId, String(confirmId || '').trim());
  if (!found) throw new WriteError('CONFIRMATION_NOT_FOUND', '找不到这条确认记录。', 404);
  const {db, row} = found;
  try {
    if (row.consumed_at) {
      throw new WriteError('CONFIRMATION_CONSUMED', '这次确认已经接受并执行，不能再拒绝。', 403);
    }
    if (row.decision === 'rejected') {
      return {ok: true, confirmId: row.confirm_id, taskId: row.task_id || '', decision: 'rejected', duplicate: true, rejectedAt: row.executed_at || '', reason: row.decision_reason || ''};
    }
    const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
    const note = String(reason || '').trim().slice(0, 500);
    const changed = db.prepare("UPDATE confirmations SET decision='rejected', decision_reason=?, executed_at=? WHERE confirm_id=? AND user_id=? AND consumed_at IS NULL AND decision='pending'")
      .run(note, at, row.confirm_id, String(userId));
    if (Number(changed.changes) !== 1) {
      const fresh = db.prepare('SELECT * FROM confirmations WHERE confirm_id=?').get(row.confirm_id);
      if (fresh && fresh.decision === 'rejected') return {ok: true, confirmId: row.confirm_id, taskId: row.task_id || '', decision: 'rejected', duplicate: true, rejectedAt: fresh.executed_at || '', reason: fresh.decision_reason || ''};
      throw new WriteError('CONFIRMATION_CONSUMED', '这次确认已经被处理过；请重新发起写入。', 409);
    }
    return {ok: true, confirmId: row.confirm_id, taskId: row.task_id || '', decision: 'rejected', duplicate: false, rejectedAt: at, reason: note};
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
}
