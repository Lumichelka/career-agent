// 写网关：所有自动写入的统一入口。
// 顺序：参数校验 →（工具去重在工具执行器 execute.mjs 已完成）→ 敏感判定与确认校验 →
// 幂等键检查与指纹比对 → BEGIN IMMEDIATE → 业务写入 + 审计 + 幂等完成 → COMMIT。
// 任何一步失败都整体回滚（fail closed）；业务写入必须用同一个 DatabaseSync，不另开连接。
import {createHash, randomBytes} from 'node:crypto';
import {ensureAuditSchema, insertAuditRow, readConfirmation} from './audit-store.mjs';

export const MAX_AUDIT_EVENT_BYTES = 256 * 1024;
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600 * 1000;
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export class WriteError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'WriteError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

const SENSITIVE_FIELD = /(phone|mobile|tel|email|mail|wechat|weixin|idcard|id_card|contact|身份证|手机|电话|邮箱|微信|联系人|证件)/i;
// 字段名看不出来时按值兜底：手机号、邮箱、身份证号出现在预览里一律抹掉。
const SENSITIVE_VALUE = /(1[3-9]\d{9}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?<!\d)\d{17}[\dXx](?!\d))/;

// 确认预览必须脱敏：联系方式、证件类字段整段抹掉，其余保留可读摘要。
export function redactPreview(value, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactPreview(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_FIELD.test(key) && item !== null && item !== undefined && item !== '' ? '***' : redactPreview(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return '***';
    return value.length > 500 ? value.slice(0, 500) + '…' : value;
  }
  return value;
}

// 稳定序列化：同样的参数永远得到同一个指纹（键顺序不影响）。
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function fingerprintOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

let uuidMs = 0;
let uuidSeq = 0;
// RFC 9562 UUIDv7：48 位毫秒时间戳 + 12 位序列（同毫秒单调）+ 62 位随机。
export function uuidv7(now = Date.now()) {
  const ms = Number(now);
  if (!Number.isFinite(ms) || ms < 0 || ms > 281474976710655) throw new RangeError('uuidv7 需要有效的毫秒时间戳');
  if (ms === uuidMs) uuidSeq = (uuidSeq + 1) & 0xfff;
  else { uuidMs = ms; uuidSeq = randomBytes(2).readUInt16BE(0) & 0xfff; }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((uuidSeq >>> 8) & 0x0f);
  bytes[7] = uuidSeq & 0xff;
  randomBytes(8).copy(bytes, 8);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

const ACTIONS = ['create', 'update', 'delete', 'skip'];

function summarize(changes) {
  const counts = {rows: changes.length, created: 0, updated: 0, deleted: 0, skipped: 0};
  for (const change of changes) {
    if (change.action === 'create') counts.created += 1;
    else if (change.action === 'update') counts.updated += 1;
    else if (change.action === 'delete') counts.deleted += 1;
    else if (change.action === 'skip') counts.skipped += 1;
  }
  return counts;
}

function parsePreview(summary) {
  try { return JSON.parse(summary); } catch { return summary; }
}

export function createWriteGateway(options) {
  return new WriteGateway(options);
}

export class WriteGateway {
  constructor({db, domain = '', userId, actorType = 'model', actorRef = '', taskId = '', now = () => new Date(), newId = uuidv7} = {}) {
    if (!db || typeof db.prepare !== 'function') throw new Error('写网关需要已打开的 node:sqlite 连接');
    if (!userId) throw new Error('写网关需要用户身份');
    this.db = db;
    this.domain = String(domain || '');
    this.userId = String(userId);
    this.actorType = String(actorType || 'model');
    this.actorRef = String(actorRef || '');
    this.taskId = String(taskId || '');
    this.now = now;
    this.newId = newId;
    ensureAuditSchema(db, this.domain);
  }

  #nowIso(offsetMs = 0) {
    const base = this.now();
    const ms = base instanceof Date ? base.getTime() : typeof base === 'number' ? base : Date.parse(base);
    return new Date(Number.isFinite(ms) ? ms + offsetMs : Date.now() + offsetMs).toISOString();
  }

  #expiresAt(createdAt, ttl) {
    return new Date(Date.parse(createdAt) + ttl).toISOString();
  }

  #idempotency(tool, key) {
    return this.db.prepare('SELECT * FROM idempotency WHERE user_id=? AND tool=? AND key=?').get(this.userId, tool, key) || null;
  }

  #deleteIdempotency(tool, key) {
    this.db.prepare('DELETE FROM idempotency WHERE user_id=? AND tool=? AND key=?').run(this.userId, tool, key);
  }

  #fresh(row) {
    return String(row.expires_at || '') > this.#nowIso();
  }

  #replay(row) {
    let stored = null;
    try { stored = JSON.parse(row.response_json || 'null'); } catch { stored = null; }
    if (!stored || typeof stored !== 'object') {
      return {status: 'replayed', duplicate: true, batchId: row.audit_batch_id || '', counts: {rows: 0, created: 0, updated: 0, deleted: 0, skipped: 0}, result: null, confirmed: !!row.confirm_id};
    }
    return {status: 'replayed', duplicate: true, ...stored};
  }

  #confirmRequired(row) {
    return {
      status: 'confirm_required',
      tool: row.tool,
      confirmId: row.confirm_id,
      taskId: row.task_id || '',
      preview: parsePreview(row.preview_summary),
      previewSummary: row.preview_summary,
      expiresAt: row.expires_at,
      fingerprint: row.fingerprint
    };
  }

  #validateConfirmation(row, {tool, fingerprint, key}) {
    if (!row) throw new WriteError('CONFIRMATION_NOT_FOUND', '找不到这条确认记录。', 404);
    if (row.tool !== tool || row.fingerprint !== fingerprint || String(row.idempotency_key) !== String(key)) {
      throw new WriteError('CONFIRMATION_MISMATCH', '确认绑定的工具、参数或幂等键与本次写入不一致，请重新发起并确认。', 422);
    }
    if (String(row.expires_at || '') <= this.#nowIso()) {
      throw new WriteError('CONFIRMATION_EXPIRED', '这次确认已过期（10 分钟），请重新发起写入。', 410);
    }
    if (row.decision === 'rejected') throw new WriteError('CONFIRMATION_REJECTED', '你已经拒绝过这次写入。', 403);
    if (row.consumed_at) throw new WriteError('CONFIRMATION_CONSUMED', '这次确认已经用过；请重新发起写入。', 409);
  }

  // 确认必须由本应用 UI 的接受接口触发（approveConfirmation）；模型自己把 confirm_id 填回来不算确认。
  #consumeConfirmation(row, {tool, fingerprint, key, approveConfirmation}) {
    const fresh = readConfirmation(this.db, this.userId, row.confirm_id);
    this.#validateConfirmation(fresh, {tool, fingerprint, key});
    if (fresh.decision !== 'accepted') {
      if (!approveConfirmation) throw new WriteError('CONFIRMATION_PENDING', '这次写入在等待用户确认。', 409);
      this.db.prepare("UPDATE confirmations SET decision='accepted' WHERE confirm_id=? AND consumed_at IS NULL").run(fresh.confirm_id);
    }
    const at = this.#nowIso();
    const changed = this.db.prepare('UPDATE confirmations SET consumed_at=?, executed_at=? WHERE confirm_id=? AND consumed_at IS NULL')
      .run(at, at, fresh.confirm_id);
    if (Number(changed.changes) !== 1) throw new WriteError('CONFIRMATION_CONSUMED', '这次确认已经用过；请重新发起写入。', 409);
    return {...fresh, decision: 'accepted', consumed_at: at};
  }

  #createConfirmation({tool, fingerprint, key, entity, entityId, action, preview, sourceRef, payloadJson}) {
    const confirmId = this.newId();
    const createdAt = this.#nowIso();
    const expiresAt = this.#expiresAt(createdAt, CONFIRMATION_TTL_MS);
    const summary = JSON.stringify(redactPreview(preview ?? {})).slice(0, 4000);
    const payload = String(payloadJson || '');
    // 确认接受时要按原参数重放；payload 超过审计单条上限时拒绝发起，避免确认无法执行。
    if (Buffer.byteLength(payload) > MAX_AUDIT_EVENT_BYTES) throw new WriteError('AUDIT_EVENT_TOO_LARGE', '这次写入的参数超过 256KB，已拒绝；请拆分或缩小内容。', 413);
    this.db.prepare(`INSERT INTO confirmations(
      confirm_id, user_id, tool, fingerprint, idempotency_key, entity, entity_id, action,
      preview_summary, source_ref, payload_json, task_id, created_at, expires_at, consumed_at, decision, executed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'pending',NULL)`).run(
      confirmId, this.userId, tool, fingerprint, key, entity || '', entityId || '', action || '', summary, sourceRef || '',
      payload, this.taskId, createdAt, expiresAt
    );
    return {confirmId, createdAt, expiresAt, summary};
  }

  // 敏感写：先挂起确认（同键同指纹重放同一确认），不落业务数据。
  #requestConfirmation(options) {
    const {tool, fingerprint, key, entity, entityId, action, preview, sourceRef, payload} = options;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#idempotency(tool, key);
      let outcome = null;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new WriteError('IDEMPOTENCY_KEY_CONFLICT', '同一幂等键已用于不同的写入参数；请换一个新的幂等键。', 422);
        }
        if (this.#fresh(existing)) {
          if (existing.status === 'completed') outcome = this.#replay(existing);
          else if (existing.status === 'in_progress') throw new WriteError('IDEMPOTENCY_IN_PROGRESS', '同一幂等键的写入仍在进行中，请稍后重试。', 409);
          else if (existing.status === 'pending_confirmation') {
            const row = readConfirmation(this.db, this.userId, existing.confirm_id);
            if (row && !row.consumed_at && row.decision !== 'rejected' && String(row.expires_at || '') > this.#nowIso()) {
              outcome = this.#confirmRequired(row);
            } else {
              this.#deleteIdempotency(tool, key);
            }
          }
        } else {
          this.#deleteIdempotency(tool, key);
        }
      }
      if (!outcome) {
        const confirmation = this.#createConfirmation({tool, fingerprint, key, entity, entityId, action, preview, sourceRef, payloadJson: canonicalJson(payload ?? {})});
        const createdAt = this.#nowIso();
        const expiresAt = this.#expiresAt(createdAt, IDEMPOTENCY_TTL_MS);
        this.db.prepare(`INSERT INTO idempotency(user_id,tool,key,fingerprint,status,response_json,confirm_id,audit_batch_id,created_at,expires_at)
          VALUES(?,?,?,?,'pending_confirmation','',?,?,?,?)`)
          .run(this.userId, tool, key, fingerprint, confirmation.confirmId, '', createdAt, expiresAt);
        outcome = {
          status: 'confirm_required', tool, confirmId: confirmation.confirmId,
          preview: parsePreview(confirmation.summary), previewSummary: confirmation.summary,
          expiresAt: confirmation.expiresAt, fingerprint
        };
      }
      this.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw this.#mapError(error);
    }
  }

  #auditRow(change, meta) {
    const action = ACTIONS.includes(change?.action) ? change.action : null;
    if (!action) throw new WriteError('INVALID_WRITE', '未知的审计动作：' + (change?.action ?? '空'), 500);
    if (!change.entity || !change.entityId) throw new WriteError('INVALID_WRITE', '审计缺少实体名或实体 id。', 500);
    const oldJson = change.oldValues === undefined || change.oldValues === null ? null : JSON.stringify(change.oldValues);
    const newJson = change.newValues === undefined || change.newValues === null ? null : JSON.stringify(change.newValues);
    const size = Buffer.byteLength((oldJson || '') + (newJson || '') + (change.note || '') + (meta.sourceRef || ''));
    if (size > MAX_AUDIT_EVENT_BYTES) {
      throw new WriteError('AUDIT_EVENT_TOO_LARGE', '单条审计事件超过 256KB，已拒绝这次写入；请拆分或缩小内容。', 413);
    }
    return {
      eventId: this.newId(),
      occurredAt: meta.occurredAt,
      userId: this.userId,
      actorType: this.actorType,
      actorRef: this.actorRef,
      tool: meta.tool,
      taskId: this.taskId,
      batchId: meta.batchId,
      action,
      entity: String(change.entity),
      entityId: String(change.entityId),
      oldValues: oldJson,
      newValues: newJson,
      sourceRef: meta.sourceRef,
      idempotencyKey: meta.key,
      requestFingerprint: meta.fingerprint,
      confirmId: meta.confirmId,
      confirmed: !!meta.confirmId,
      undoOf: '',
      result: change.result || (action === 'skip' ? 'skipped_conflict' : 'applied'),
      note: change.note || ''
    };
  }

  #complete({tool, key, fingerprint, batchId, confirmId, response}) {
    const serialized = JSON.stringify(response);
    const changed = this.db.prepare(`UPDATE idempotency SET status='completed', fingerprint=?, response_json=?, confirm_id=?, audit_batch_id=?
      WHERE user_id=? AND tool=? AND key=?`).run(fingerprint, serialized, confirmId || '', batchId, this.userId, tool, key);
    if (Number(changed.changes) === 0) {
      const createdAt = this.#nowIso();
      this.db.prepare(`INSERT INTO idempotency(user_id,tool,key,fingerprint,status,response_json,confirm_id,audit_batch_id,created_at,expires_at)
        VALUES(?,?,?,?,'completed',?,?,?,?,?)`).run(
        this.userId, tool, key, fingerprint, serialized, confirmId || '', batchId, createdAt, this.#expiresAt(createdAt, IDEMPOTENCY_TTL_MS)
      );
    }
  }

  #mapError(error) {
    if (error instanceof WriteError) return error;
    const message = String(error?.message || error);
    if (/SQLITE_BUSY|database is locked/i.test(message)) {
      return new WriteError('WRITE_LOCKED', '数据库正忙，本次写入没有执行；请稍后重试。', 409, {cause: error});
    }
    if (/SQLITE_CONSTRAINT/i.test(message)) {
      return new WriteError('WRITE_CONSTRAINT', '写入违反数据约束，已整体回滚：' + message, 422, {cause: error});
    }
    return new WriteError('WRITE_FAILED', '写入失败，已整体回滚：' + message, 500, {cause: error});
  }

  /**
   * 执行一次自动写入。
   * - payload 决定指纹；idempotencyKey 必填。
   * - sensitivity='sensitive' 且没有 confirmId 时返回 confirm_required（10 分钟确认）。
   * - confirmId 由本应用确认接口带上；approveConfirmation 只应由服务端在用户点了接受之后传 true。
   * - execute 必须是同步函数，返回 changes 数组或 {changes, result}；changes 每项对应一条业务行。
   */
  async write({tool, sensitivity = 'auto', payload = {}, idempotencyKey, confirmId = '', confirmationKey = '', preview = null, sourceRef = null, entity = '', entityId = '', action = '', approveConfirmation = false, execute} = {}) {
    if (typeof tool !== 'string' || !tool.trim()) throw new WriteError('INVALID_WRITE', '写入缺少工具名。', 400);
    if (typeof execute !== 'function') throw new WriteError('INVALID_WRITE', '写入缺少业务实现。', 500);
    const key = String(idempotencyKey ?? '').trim();
    if (!key) throw new WriteError('MISSING_IDEMPOTENCY_KEY', '自动写入必须带幂等键 idempotencyKey。', 400);
    if (key.length > 200) throw new WriteError('INVALID_IDEMPOTENCY_KEY', '幂等键不能超过 200 个字符。', 400);
    const fingerprint = fingerprintOf(payload ?? {});
    const confirm = String(confirmId ?? '').trim();
    const boundKey = String(confirmationKey || key).trim();
    const sourceJson = sourceRef === null || sourceRef === undefined ? '' : JSON.stringify(sourceRef);

    if (sensitivity === 'sensitive' && !confirm) {
      return this.#requestConfirmation({tool, fingerprint, key, entity, entityId, action, preview, sourceRef: sourceJson, payload: payload ?? {}});
    }

    // 事务外的快速判定：已完成直接重放，进行中/指纹冲突直接拒绝。
    const before = this.#idempotency(tool, key);
    if (before && this.#fresh(before)) {
      if (before.fingerprint !== fingerprint) {
        throw new WriteError('IDEMPOTENCY_KEY_CONFLICT', '同一幂等键已用于不同的写入参数；请换一个新的幂等键。', 422);
      }
      if (before.status === 'completed') return this.#replay(before);
      if (before.status === 'in_progress') {
        throw new WriteError('IDEMPOTENCY_IN_PROGRESS', '同一幂等键的写入仍在进行中，请稍后重试。', 409);
      }
    }
    let confirmation = null;
    if (confirm) {
      confirmation = readConfirmation(this.db, this.userId, confirm);
      this.#validateConfirmation(confirmation, {tool, fingerprint, key: boundKey});
      if (!approveConfirmation && confirmation.decision !== 'accepted') return this.#confirmRequired(confirmation);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#idempotency(tool, key);
      let pendingRow = null;
      if (existing && this.#fresh(existing)) {
        if (existing.fingerprint !== fingerprint) {
          throw new WriteError('IDEMPOTENCY_KEY_CONFLICT', '同一幂等键已用于不同的写入参数；请换一个新的幂等键。', 422);
        }
        if (existing.status === 'completed') {
          const replay = this.#replay(existing);
          this.db.exec('ROLLBACK');
          return replay;
        }
        if (existing.status === 'in_progress') {
          throw new WriteError('IDEMPOTENCY_IN_PROGRESS', '同一幂等键的写入仍在进行中，请稍后重试。', 409);
        }
        if (existing.status === 'pending_confirmation') pendingRow = existing;
      } else if (existing) {
        this.#deleteIdempotency(tool, key);
      }

      if (confirmation) confirmation = this.#consumeConfirmation(confirmation, {tool, fingerprint, key: boundKey, approveConfirmation});

      const createdAt = this.#nowIso();
      const expiresAt = this.#expiresAt(createdAt, IDEMPOTENCY_TTL_MS);
      if (pendingRow) {
        this.db.prepare(`UPDATE idempotency SET fingerprint=?, status='in_progress', response_json='', confirm_id=?, audit_batch_id='', created_at=?, expires_at=?
          WHERE user_id=? AND tool=? AND key=?`).run(fingerprint, confirm || '', createdAt, expiresAt, this.userId, tool, key);
      } else {
        this.db.prepare(`INSERT INTO idempotency(user_id,tool,key,fingerprint,status,response_json,confirm_id,audit_batch_id,created_at,expires_at)
          VALUES(?,?,?,?,'in_progress','',?,?,?,?)`).run(this.userId, tool, key, fingerprint, confirm || '', '', createdAt, expiresAt);
      }

      const output = execute({db: this.db});
      if (output && typeof output.then === 'function') throw new WriteError('INVALID_WRITE', '业务写入必须同步完成，不能返回 Promise。', 500);
      const changes = Array.isArray(output) ? output : output?.changes;
      if (!Array.isArray(changes)) throw new WriteError('INVALID_WRITE', '业务写入没有返回变更行。', 500);

      const batchId = this.newId();
      const occurredAt = this.#nowIso();
      for (const change of changes) {
        insertAuditRow(this.db, this.#auditRow(change, {tool, key, fingerprint, batchId, occurredAt, confirmId: confirm, sourceRef: sourceJson}));
      }
      const counts = summarize(changes);
      const response = {batchId, counts, result: output?.result ?? null, confirmed: !!confirm};
      this.#complete({tool, key, fingerprint, batchId, confirmId: confirm, response});
      // 确认接口用新幂等键执行时，原键也要标完成，重试原请求才不会再写一遍。
      if (confirm && boundKey !== key) {
        this.#complete({tool, key: boundKey, fingerprint, batchId, confirmId: confirm, response});
      }
      this.db.exec('COMMIT');
      return {status: 'applied', duplicate: false, ...response};
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw this.#mapError(error);
    }
  }
}
