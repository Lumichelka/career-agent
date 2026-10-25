// 审计审阅与撤销层：预检、逆操作、撤销审计。
// 撤销本身也是一次新的写入：新的 batch_id + write_audit 行（undo_of 指向被撤销的原始事件）。
// 业务恢复按域/实体查表，整行写回（含时间戳）；新增域只需要在 ENTITY_CODECS 登记表名与列。
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hasAuditSchema, insertAuditRow, listAuditBatches} from './audit-store.mjs';
import {WRITE_DOMAINS, domainEntry} from './domains.mjs';
import {fingerprintOf, uuidv7} from './gateway.mjs';
import {readAudit} from './audit-api.mjs';

export class UndoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'UndoError';
    this.code = code;
    this.status = status;
  }
}

const TEXT = value => value === undefined || value === null ? null : String(value);
const NUMBER = value => value === undefined || value === null || value === '' ? null : Number(value);
const BOOLEAN = value => value ? 1 : 0;
const LIST = value => Array.isArray(value) ? value.join(',') : (value === undefined || value === null ? null : String(value));

// [数据库列, 审计投影字段, 编码]；审计投影缺字段的列不参与预检，恢复时保留当前值或用默认值。
// 撤销重建必须写回所有列（含时间戳），这样「行 + 内容哈希」快照才能与写入前一致。
const ENTITY_CODECS = {
  recruit: {
    events: {
      table: 'events',
      primaryKey: 'id',
      columns: [
        ['id', 'id', TEXT],
        ['source_id', 'sourceId', TEXT],
        ['school', 'school', TEXT],
        ['city', 'city', TEXT],
        ['kind', 'kind', TEXT],
        ['title', 'title', TEXT],
        ['company', 'company', TEXT],
        ['start_at', 'startAt', TEXT],
        ['end_at', 'endAt', TEXT],
        ['venue', 'venue', TEXT],
        ['address', 'address', TEXT],
        ['industry', 'industry', TEXT],
        ['company_size', 'companySize', TEXT],
        ['positions', 'positions', TEXT],
        ['requirements', 'requirements', TEXT],
        ['apply_mode', 'applyMode', TEXT],
        ['apply_url', 'applyUrl', TEXT],
        ['source_url', 'sourceUrl', TEXT],
        ['published_at', 'publishedAt', TEXT],
        ['fetched_at', 'fetchedAt', TEXT],
        ['confidence', 'confidence', NUMBER],
        ['verified', 'verified', BOOLEAN],
        ['raw_text', 'rawText', TEXT],
        ['notes', 'notes', TEXT],
        ['interview_stage', 'interviewStage', TEXT],
        ['interview_type', 'interviewType', TEXT],
        ['status', 'status', TEXT],
        ['first_seen_at', 'firstSeenAt', TEXT],
        ['last_seen_at', 'lastSeenAt', TEXT],
        ['missing_runs', 'missingRuns', NUMBER],
        ['cross_sources', 'crossSources', LIST]
      ]
    },
    event_projects: {
      table: 'event_projects',
      primaryKey: 'id',
      columns: [
        ['id', 'id', TEXT],
        ['event_id', 'eventId', TEXT],
        ['company', 'company', TEXT],
        ['title', 'title', TEXT],
        ['positions', 'positions', TEXT],
        ['requirements', 'requirements', TEXT],
        ['apply_mode', 'applyMode', TEXT],
        ['apply_url', 'applyUrl', TEXT],
        ['source_url', 'sourceUrl', TEXT],
        ['notes', 'notes', TEXT],
        ['source_id', 'sourceId', TEXT],
        ['source_key', 'sourceKey', TEXT],
        ['status', 'status', TEXT],
        ['confidence', 'confidence', NUMBER],
        ['first_seen_at', 'firstSeenAt', TEXT],
        ['last_seen_at', 'lastSeenAt', TEXT],
        ['missing_runs', 'missingRuns', NUMBER],
        ['created_at', 'createdAt', TEXT],
        ['updated_at', 'updatedAt', TEXT]
      ],
      // 审计投影没有 raw_text：批量写入从不写这一列，恢复时保留当前值，重建时用空串。
      extraColumns: [['raw_text', "''"]]
    }
  },
  // 画像写库的逆操作映射已就位：新增实体只需要登记表名与列，预检/逆操作/审计不用改。
  profile: {
    profile_facts: {
      table: 'profile_facts',
      primaryKey: 'id',
      columns: [
        ['id', 'id', TEXT],
        ['user_id', 'userId', TEXT],
        ['key', 'key', TEXT],
        ['value', 'value', TEXT],
        ['source', 'source', TEXT],
        ['created_at', 'createdAt', TEXT],
        ['updated_at', 'updatedAt', TEXT]
      ]
    }
  }
};

export function entityCodec(domain, entity) {
  return ENTITY_CODECS[String(domain || '')]?.[String(entity || '')] || null;
}

function openDomainDb(dir, domain) {
  const entry = domainEntry(domain);
  if (!entry) return null;
  const file = join(String(dir), entry.file);
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  if (!hasAuditSchema(db)) { db.close(); return null; }
  return {entry, db};
}

function readCurrent(db, codec, entityId) {
  try { return db.prepare('SELECT * FROM ' + codec.table + ' WHERE ' + codec.primaryKey + '=?').get(String(entityId)) || null; }
  catch { return null; }
}

function comparable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

// 当前行是否仍等于审计里记录的新值（撤销预检的 test 原语）。
function compareRow(codec, projection, current) {
  if (!current) return {matches: false, changed: codec.columns.map(([column]) => column)};
  const changed = [];
  for (const [column, field, encode] of codec.columns) {
    if (comparable(encode(projection?.[field])) !== comparable(current[column])) changed.push(column);
  }
  return {matches: changed.length === 0, changed};
}

function inversePlan(row, current) {
  if (row.action === 'create') {
    return {auditAction: 'delete', target: null, oldValues: current || null, newValues: null};
  }
  if (row.action === 'update' || row.action === 'delete') {
    const auditAction = current ? 'update' : 'create';
    return {auditAction, target: row.oldValues, oldValues: current || null, newValues: row.oldValues};
  }
  return null;
}

function preflightRow(codec, row, current, alreadyUndone = false) {
  if (alreadyUndone) return {status: 'already_undone', reason: 'already_undone'};
  if (!codec) return {status: 'conflict', reason: 'unsupported_entity'};
  if (row.action === 'create') {
    if (!current) return {status: 'conflict', reason: 'created_row_missing'};
    const compared = compareRow(codec, row.newValues, current);
    return compared.matches ? {status: 'ready', reason: 'created'} : {status: 'conflict', reason: 'created_row_changed', changed: compared.changed};
  }
  if (row.action === 'update') {
    if (!current) return {status: 'conflict', reason: 'updated_row_missing'};
    const compared = compareRow(codec, row.newValues, current);
    return compared.matches ? {status: 'ready', reason: 'updated'} : {status: 'conflict', reason: 'updated_row_changed', changed: compared.changed};
  }
  if (row.action === 'delete') {
    if (!current) return {status: 'ready', reason: 'deleted'};
    const compared = compareRow(codec, row.newValues, current);
    return compared.matches ? {status: 'ready', reason: 'deleted_unchanged'} : {status: 'conflict', reason: 'deleted_row_recreated', changed: compared.changed};
  }
  return {status: 'conflict', reason: 'unsupported_action'};
}

function insertRestoredRow(db, codec, target, entityId) {
  const columns = codec.columns.map(([column]) => column);
  const values = codec.columns.map(([column, field, encode]) => encode(target?.[field]));
  for (const [column, defaultSql] of codec.extraColumns || []) {
    columns.push(column);
    values.push(defaultSql === "''" ? '' : null);
  }
  if (target && target[codec.primaryKey] === undefined) {
    const index = columns.indexOf(codec.primaryKey);
    if (index >= 0) values[index] = String(entityId);
  }
  db.prepare('INSERT INTO ' + codec.table + '(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')').run(...values);
}

function updateRestoredRow(db, codec, target, entityId) {
  const columns = codec.columns.filter(([column]) => column !== codec.primaryKey);
  const assignments = columns.map(([column]) => column + '=?').join(', ');
  const values = columns.map(([column, field, encode]) => encode(target?.[field]));
  db.prepare('UPDATE ' + codec.table + ' SET ' + assignments + ' WHERE ' + codec.primaryKey + '=?').run(...values, String(entityId));
}

function executeInverse(db, codec, plan, entityId) {
  if (plan.auditAction === 'delete') {
    db.prepare('DELETE FROM ' + codec.table + ' WHERE ' + codec.primaryKey + '=?').run(String(entityId));
    return;
  }
  if (plan.auditAction === 'create') {
    insertRestoredRow(db, codec, plan.target, entityId);
    return;
  }
  updateRestoredRow(db, codec, plan.target, entityId);
}

function sourceText(value) {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function writeUndoAuditRow(db, entry, row, meta) {
  const eventId = uuidv7();
  insertAuditRow(db, {
    eventId,
    occurredAt: new Date().toISOString(),
    userId: meta.userId,
    actorType: 'user',
    actorRef: 'undo',
    tool: row.tool,
    taskId: row.taskId || '',
    batchId: meta.newBatchId,
    action: meta.action,
    entity: row.entity,
    entityId: row.entityId,
    oldValues: meta.oldValues === undefined || meta.oldValues === null ? null : JSON.stringify(meta.oldValues),
    newValues: meta.newValues === undefined || meta.newValues === null ? null : JSON.stringify(meta.newValues),
    sourceRef: sourceText(row.sourceRef),
    idempotencyKey: 'undo:' + row.batchId,
    requestFingerprint: meta.fingerprint,
    confirmId: '',
    confirmed: false,
    undoOf: row.eventId,
    result: meta.result,
    note: meta.note || ''
  });
  return eventId;
}

// 某行是否已被撤销过：applied/forced 算已撤销，只有 skipped_conflict 算冲突未处理。
function undoStateByEvent(db, userId, eventIds) {
  const state = new Map();
  if (!eventIds.length) return state;
  const ids = [...new Set(eventIds.map(String))];
  for (let index = 0; index < ids.length; index += 400) {
    const chunk = ids.slice(index, index + 400);
    const marks = chunk.map(() => '?').join(',');
    let rows = [];
    try {
      rows = db.prepare('SELECT undo_of, result FROM write_audit WHERE user_id=? AND undo_of IN (' + marks + ')').all(String(userId), ...chunk);
    } catch { rows = []; }
    for (const row of rows) {
      const entry = state.get(row.undo_of) || {undone: false, forced: false, conflict: false};
      if (row.result === 'applied' || row.result === 'forced') entry.undone = true;
      if (row.result === 'forced') entry.forced = true;
      if (row.result === 'skipped_conflict') entry.conflict = true;
      state.set(row.undo_of, entry);
    }
  }
  return state;
}

function resultOf(row, extra = {}) {
  return {
    seq: row.seq,
    eventId: row.eventId,
    entity: row.entity,
    entityId: row.entityId,
    action: row.action,
    result: extra.result,
    reason: extra.reason || '',
    conflict: !!extra.conflict,
    changed: Array.isArray(extra.changed) ? extra.changed : [],
    current: extra.current ?? null,
    desired: extra.desired ?? null,
    undoAction: extra.undoAction || '',
    auditEventId: extra.auditEventId || '',
    skipAuditEventId: extra.skipAuditEventId || ''
  };
}

function findBatch({dir, userId, batchId}) {
  if (!dir || !userId || !batchId) return null;
  for (const entry of WRITE_DOMAINS) {
    const file = join(String(dir), entry.file);
    if (!existsSync(file)) continue;
    let db = null;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 5000');
      if (!hasAuditSchema(db)) { db.close(); continue; }
      const batches = listAuditBatches(db, {userId, batchId, domain: entry.domain});
      if (batches.length) return {entry, db, batch: batches[0]};
      db.close();
    } catch {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  return null;
}

function buildBatchPreview(entry, db, batch, undoState) {
  const rows = [];
  const counts = {rows: 0, ready: 0, conflicts: 0, already: 0, unsupported: 0};
  for (const row of batch.rows) {
    if (row.undoOf) continue; // 撤销批次本身不再被撤销
    const state = undoState.get(row.eventId);
    const codec = entityCodec(entry.domain, row.entity);
    const current = codec ? readCurrent(db, codec, row.entityId) : null;
    const pre = preflightRow(codec, row, current, !!state?.undone);
    const desired = row.action === 'create' ? null : row.oldValues;
    counts.rows += 1;
    if (pre.status === 'already_undone') counts.already += 1;
    else if (pre.status === 'ready') counts.ready += 1;
    else if (!codec) { counts.conflicts += 1; counts.unsupported += 1; }
    else counts.conflicts += 1;
    rows.push(resultOf(row, {
      result: pre.status,
      reason: pre.reason,
      conflict: pre.status === 'conflict',
      changed: pre.changed,
      current,
      desired
    }));
  }
  return {batchId: batch.batchId, domain: entry.domain, taskId: batch.taskId || '', tool: batch.tool, occurredAt: batch.occurredAt, force: false, counts, results: rows};
}

// 预览不写库：单批或整任务，给出每行当前值、写回值与冲突原因。
export function previewUndo({dir, userId, batchId = '', taskId = ''} = {}) {
  if (!batchId && !taskId) throw new UndoError('INVALID_ARGUMENTS', '预览需要 batchId 或 taskId。', 400);
  if (batchId) {
    const found = findBatch({dir, userId, batchId});
    if (!found) throw new UndoError('BATCH_NOT_FOUND', '找不到这个自动写入批次。', 404);
    try {
      const undoState = undoStateByEvent(found.db, userId, found.batch.rows.map(row => row.eventId));
      const preview = buildBatchPreview(found.entry, found.db, found.batch, undoState);
      return {ok: true, scope: 'batch', batchId, taskId: found.batch.taskId || '', batches: [preview], counts: {...preview.counts, batches: 1}};
    } finally { found.db.close(); }
  }
  const view = readAudit({dir, userId, taskId, limit: 200});
  const originals = view.batches.filter(batch => !batch.rows.some(row => row.undoOf));
  const batches = [];
  const total = {rows: 0, ready: 0, conflicts: 0, already: 0, unsupported: 0, batches: originals.length};
  for (const batch of originals) {
    const opened = openDomainDb(dir, batch.domain);
    if (!opened) continue;
    try {
      const undoState = undoStateByEvent(opened.db, userId, batch.rows.map(row => row.eventId));
      const preview = buildBatchPreview(opened.entry, opened.db, batch, undoState);
      batches.push(preview);
      for (const key of ['rows', 'ready', 'conflicts', 'already', 'unsupported']) total[key] += preview.counts[key];
    } finally { opened.db.close(); }
  }
  return {ok: true, scope: 'task', taskId, batchId: '', batches, counts: total};
}

// 单批撤销：一个事务里预检 + 逆操作 + 撤销审计；默认跳过冲突，force 写回旧值。
export async function undoBatch({dir, userId, batchId, force = false, onlyEventIds = null} = {}) {
  if (!batchId) throw new UndoError('INVALID_ARGUMENTS', '缺少 batchId。', 400);
  const found = findBatch({dir, userId, batchId});
  if (!found) throw new UndoError('BATCH_NOT_FOUND', '找不到这个自动写入批次。', 404);
  const {entry, db, batch} = found;
  try {
    const selected = batch.rows.filter(row => !row.undoOf && (!onlyEventIds || onlyEventIds.has(row.eventId)));
    const newBatchId = uuidv7();
    const fingerprint = fingerprintOf({batchId, force: !!force});
    const results = [];
    const counts = {rows: 0, undone: 0, conflicts: 0, forced: 0, failed: 0, already: 0};
    const undoState = undoStateByEvent(db, userId, selected.map(row => row.eventId));
    let taskId = batch.taskId || '';
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of selected.sort((a, b) => a.seq - b.seq)) {
        taskId = taskId || row.taskId;
        const state = undoState.get(row.eventId);
        if (state?.undone) {
          counts.already += 1;
          results.push(resultOf(row, {result: 'already_undone', reason: '已经撤销过这一行'}));
          continue;
        }
        const codec = entityCodec(entry.domain, row.entity);
        if (!codec) {
          counts.rows += 1;
          counts.failed += 1;
          results.push(resultOf(row, {result: 'failed', reason: '不支持的实体：' + row.entity}));
          continue;
        }
        const current = readCurrent(db, codec, row.entityId);
        const pre = preflightRow(codec, row, current, false);
        let skipAuditEventId = '';
        if (pre.status === 'conflict') {
          skipAuditEventId = writeUndoAuditRow(db, entry, row, {
            userId, newBatchId, fingerprint,
            action: 'skip', oldValues: current, newValues: row.action === 'create' ? null : row.oldValues,
            result: 'skipped_conflict', note: '撤销冲突：' + (pre.reason || '当前值已变化')
          });
          counts.conflicts += 1;
          if (!force) {
            counts.rows += 1;
            results.push(resultOf(row, {
              result: 'skipped_conflict', reason: pre.reason, conflict: true, changed: pre.changed,
              current, desired: row.action === 'create' ? null : row.oldValues, skipAuditEventId
            }));
            continue;
          }
        }
        const plan = inversePlan(row, current);
        if (!plan) {
          counts.rows += 1;
          counts.failed += 1;
          results.push(resultOf(row, {result: 'failed', reason: '不支持撤销的动作：' + row.action}));
          continue;
        }
        const forced = pre.status === 'conflict';
        executeInverse(db, codec, plan, row.entityId);
        const auditEventId = writeUndoAuditRow(db, entry, row, {
          userId, newBatchId, fingerprint,
          action: plan.auditAction, oldValues: plan.oldValues, newValues: plan.newValues,
          result: forced ? 'forced' : 'applied',
          note: forced ? '强制撤销：按旧值覆盖当前内容' : '撤销自动写入'
        });
        counts.rows += 1;
        counts.undone += 1;
        if (forced) counts.forced += 1;
        results.push(resultOf(row, {
          result: forced ? 'forced' : 'undone', reason: pre.reason, conflict: forced, changed: pre.changed,
          current, desired: plan.newValues, undoAction: plan.auditAction, auditEventId, skipAuditEventId
        }));
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw new UndoError('UNDO_BATCH_FAILED', '撤销失败，本批已整体回滚：' + String(error?.message || error), 500);
    }
    return {ok: counts.failed === 0, scope: 'batch', batchId, newBatchId, domain: entry.domain, taskId, force: !!force, counts, results};
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
}

// 任务级撤销：批次新→旧，逐批一个事务；意外错误立即停止，聚合计数。
export async function undoTask({dir, userId, taskId, force = false} = {}) {
  if (!taskId) throw new UndoError('INVALID_ARGUMENTS', '缺少 taskId。', 400);
  const view = readAudit({dir, userId, taskId, limit: 200});
  const originals = view.batches.filter(batch => !batch.rows.some(row => row.undoOf));
  const ordered = [...originals].sort((a, b) => {
    const byTime = String(b.occurredAt).localeCompare(String(a.occurredAt));
    if (byTime) return byTime;
    return (b.rows.at(-1)?.seq || 0) - (a.rows.at(-1)?.seq || 0);
  });
  const counts = {undone: 0, conflicts: 0, forced: 0, failed: 0, already: 0, rows: 0, batches: 0, batchesUndone: 0};
  const batches = [];
  let stopped = false;
  for (const batch of ordered) {
    counts.batches += 1;
    try {
      const out = await undoBatch({dir, userId, batchId: batch.batchId, force});
      batches.push({batchId: out.batchId, newBatchId: out.newBatchId, ok: out.ok, counts: out.counts, results: out.results});
      for (const key of ['undone', 'conflicts', 'forced', 'failed', 'already', 'rows']) counts[key] += out.counts[key] || 0;
      if (out.counts.conflicts === 0 && out.counts.failed === 0) counts.batchesUndone += 1;
      if (out.counts.failed > 0) { stopped = true; break; }
    } catch (error) {
      const failed = batch.rows.length;
      counts.failed += failed;
      counts.rows += failed;
      batches.push({
        batchId: batch.batchId, newBatchId: '', ok: false,
        error: {code: error?.code || 'UNDO_BATCH_FAILED', message: String(error?.message || error)},
        counts: {rows: failed, undone: 0, conflicts: 0, forced: 0, failed, already: 0}, results: []
      });
      stopped = true;
      break;
    }
  }
  return {ok: !stopped, scope: 'task', taskId, force: !!force, counts, batches, stopped};
}

// 任务卡的撤销摘要：读取任务所有原始批次与撤销记录，返回可撤销行数/冲突/已完成情况。
export function summarizeTaskUndo({dir, userId, taskId} = {}) {
  const empty = {available: false, summary: '本次任务没有自动写入记录。', rows: 0, batches: 0, undone: 0, conflicts: 0, forced: 0, failed: 0, already: 0, remaining: 0, allUndone: false, undoneBatches: 0, pendingBatches: 0};
  if (!dir || !userId || !taskId) return empty;
  let view;
  try { view = readAudit({dir, userId, taskId, limit: 200}); } catch { return empty; }
  const originals = [];
  const undoRows = [];
  for (const batch of view.batches) {
    for (const row of batch.rows) {
      if (row.undoOf) undoRows.push(row);
      else originals.push(row);
    }
  }
  if (!originals.length) return empty;
  const state = new Map();
  for (const row of undoRows) {
    const entry = state.get(row.undoOf) || {undone: false, forced: false, conflict: false};
    if (row.result === 'applied' || row.result === 'forced') entry.undone = true;
    if (row.result === 'forced') entry.forced = true;
    if (row.result === 'skipped_conflict') entry.conflict = true;
    state.set(row.undoOf, entry);
  }
  const byBatch = new Map();
  let undone = 0;
  let forced = 0;
  let remaining = 0;
  let conflicts = 0;
  for (const row of originals) {
    const entry = state.get(row.eventId);
    if (entry?.undone) {
      undone += 1;
      if (entry.forced) forced += 1;
    } else {
      remaining += 1;
      if (entry?.conflict) conflicts += 1;
    }
    if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
    byBatch.get(row.batchId).push(row);
  }
  const batches = byBatch.size;
  const undoneBatches = [...byBatch.values()].filter(rows => rows.every(row => state.get(row.eventId)?.undone)).length;
  const pendingBatches = batches - undoneBatches;
  const allUndone = remaining === 0;
  let summary;
  if (allUndone) summary = '已撤销全部 ' + originals.length + ' 条自动写入（' + batches + ' 个批次）' + (forced ? '，其中 ' + forced + ' 条为强制覆盖' : '') + '。';
  else if (conflicts > 0) summary = '已撤销 ' + undone + ' 条，剩余 ' + remaining + ' 条（其中 ' + conflicts + ' 条冲突）待处理，共 ' + batches + ' 个批次。';
  else summary = '可撤销 ' + remaining + ' 条自动写入（' + pendingBatches + ' 个批次）' + (undone ? '；已撤销 ' + undone + ' 条' : '') + '。';
  return {
    available: remaining > 0,
    summary,
    rows: originals.length,
    batches,
    undone,
    conflicts,
    forced,
    failed: 0,
    already: 0,
    remaining,
    allUndone,
    undoneBatches,
    pendingBatches,
    updatedAt: new Date().toISOString()
  };
}

function failure(error) {
  if (error instanceof UndoError) return {json: {error: error.message, code: error.code}, status: error.status};
  return {json: {error: String(error?.message || error), code: 'UNDO_FAILED'}, status: 500};
}

export function handleUndoPreview({dir, userId, url}) {
  try {
    const batchId = String(url.searchParams.get('batchId') || '').trim();
    const taskId = String(url.searchParams.get('taskId') || '').trim();
    return {json: previewUndo({dir, userId, batchId, taskId}), status: 200};
  } catch (error) { return failure(error); }
}

export async function handleUndoBatch({dir, userId, body}) {
  try {
    const batchId = String(body?.batchId || '').trim();
    const out = await undoBatch({dir, userId, batchId, force: body?.force === true});
    const undo = summarizeTaskUndo({dir, userId, taskId: out.taskId});
    return {json: {...out, undo}, status: 200};
  } catch (error) { return failure(error); }
}

export async function handleUndoTask({dir, userId, body}) {
  try {
    const taskId = String(body?.taskId || '').trim();
    const force = body?.force === true;
    const out = await undoTask({dir, userId, taskId, force});
    const undo = summarizeTaskUndo({dir, userId, taskId});
    return {json: {...out, undo}, status: 200};
  } catch (error) { return failure(error); }
}
