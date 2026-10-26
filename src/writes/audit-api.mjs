// GET /api/audit：按任务/批次/时间/发起者/工具/实体读取当前用户自己的自动写入审计。
// GET /api/audit/export：把当前筛选结果导出成 JSON / CSV（服务端生成，带文件名与计数）。
// POST /api/audit/clear：输入指定短语后清空本人的审计与确认记录；幂等行保留到 TTL。
// 只读路径不建表：库还没发生过自动写入时，不留下任何审计痕迹。
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {countAuditRows, ensureAuditSchema, hasAuditSchema, listAuditBatches} from './audit-store.mjs';
import {WRITE_DOMAINS} from './domains.mjs';

// 每个自动写入域一个库；域清单与写网关共用，新增域只改 domains.mjs。
export const AUDIT_DOMAINS = WRITE_DOMAINS;
// 清空必须原样输入这句；接口与界面共用同一份文案（接口响应里回传，界面不用自己抄）。
export const CLEAR_PHRASE = '清空我的审计';
// 审计体量提示阈值：达到后 /api/audit 回传提示，全局审计界面建议导出后清空。
export const AUDIT_VOLUME_THRESHOLD = 2000;
const MAX_LIMIT = 200;

export class AuditQueryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuditQueryError';
    this.code = code;
    this.status = status;
  }
}

function clampLimit(value, fallback = 50) {
  return Math.max(1, Math.min(MAX_LIMIT, Number(value) || fallback));
}

// 时间统一成数据库里的 ISO（UTC）字符串再比较；非法值明确报 400，不静默忽略。
function parseInstant(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new AuditQueryError('INVALID_FILTER', label + '不是合法时间：' + text, 400);
  return new Date(ms).toISOString();
}

export function parseAuditFilters(params) {
  const text = name => String(params.get(name) || '').trim();
  const filters = {
    taskId: text('taskId'),
    batchId: text('batchId'),
    from: parseInstant(params.get('from'), '起始时间'),
    to: parseInstant(params.get('to'), '结束时间'),
    actorType: text('actorType'),
    actorRef: text('actorRef'),
    tool: text('tool'),
    entity: text('entity')
  };
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AuditQueryError('INVALID_FILTER', '起始时间不能晚于结束时间。', 400);
  }
  return filters;
}

function emptyView(filters) {
  return {
    batches: [],
    counts: {batches: 0, rows: 0, create: 0, update: 0, delete: 0, skip: 0},
    filters,
    lastClearedAt: null,
    clearPhrase: CLEAR_PHRASE,
    volume: {rows: 0, threshold: AUDIT_VOLUME_THRESHOLD, hint: '', shouldPrompt: false}
  };
}

export function readAudit({dir, userId, taskId = '', batchId = '', limit = 50, from = '', to = '', actorType = '', actorRef = '', tool = '', entity = ''} = {}) {
  const filters = {taskId, batchId, limit, from, to, actorType, actorRef, tool, entity};
  if (!dir || !userId) return emptyView(filters);
  const batches = [];
  let lastClearedAt = null;
  let totalRows = 0;
  for (const entry of AUDIT_DOMAINS) {
    const file = join(dir, entry.file);
    if (!existsSync(file)) continue;
    let db = null;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 5000');
      if (!hasAuditSchema(db)) continue;
      totalRows += countAuditRows(db, userId);
      try {
        const meta = db.prepare('SELECT last_cleared_at FROM audit_meta WHERE domain=?').get(entry.domain);
        if (meta?.last_cleared_at && (!lastClearedAt || String(meta.last_cleared_at) > lastClearedAt)) lastClearedAt = String(meta.last_cleared_at);
      } catch { /* 旧库还没有 audit_meta：按未清空处理 */ }
      batches.push(...listAuditBatches(db, {userId, taskId, batchId, limit, domain: entry.domain, from, to, actorType, actorRef, tool, entity}));
    } catch {
      // 单个库读不出来不影响其它域；审计失败不伪造数据。
      continue;
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  batches.sort((a, b) => (b.rows.at(-1)?.seq || 0) - (a.rows.at(-1)?.seq || 0));
  const capped = batchId ? batches : batches.slice(0, clampLimit(limit));
  const counts = {batches: capped.length, rows: 0, create: 0, update: 0, delete: 0, skip: 0};
  for (const batch of capped) {
    for (const row of batch.rows) {
      counts.rows += 1;
      if (counts[row.action] !== undefined) counts[row.action] += 1;
    }
  }
  const shouldPrompt = totalRows >= AUDIT_VOLUME_THRESHOLD;
  const volume = {
    rows: totalRows,
    threshold: AUDIT_VOLUME_THRESHOLD,
    shouldPrompt,
    hint: shouldPrompt ? '审计已 ' + totalRows + ' 条，建议导出后清空' : ''
  };
  return {batches: capped, counts, filters, lastClearedAt, clearPhrase: CLEAR_PHRASE, volume};
}

async function handleAuditQuery({dir, userId, url}) {
  const filters = parseAuditFilters(url.searchParams);
  const limit = clampLimit(url.searchParams.get('limit'), 50);
  return {json: readAudit({dir, userId, ...filters, limit}), status: 200};
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

const CSV_COLUMNS = [
  ['seq', row => row.seq],
  ['eventId', row => row.eventId],
  ['occurredAt', row => row.occurredAt],
  ['domain', row => row.domain],
  ['taskId', row => row.taskId],
  ['batchId', row => row.batchId],
  ['tool', row => row.tool],
  ['actorType', row => row.actorType],
  ['actorRef', row => row.actorRef],
  ['action', row => row.action],
  ['entity', row => row.entity],
  ['entityId', row => row.entityId],
  ['oldValues', row => row.oldValues],
  ['newValues', row => row.newValues],
  ['sourceRef', row => row.sourceRef],
  ['result', row => row.result],
  ['note', row => row.note],
  ['undoOf', row => row.undoOf],
  ['idempotencyKey', row => row.idempotencyKey],
  ['confirmId', row => row.confirmId],
  ['confirmed', row => row.confirmed ? 1 : 0],
  ['batchRows', row => row.batchRows],
  ['batchCreate', row => row.batchCounts?.create || 0],
  ['batchUpdate', row => row.batchCounts?.update || 0],
  ['batchDelete', row => row.batchCounts?.delete || 0],
  ['batchSkip', row => row.batchCounts?.skip || 0]
];

function toCsv(batches) {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const batch of batches) {
    for (const row of batch.rows) {
      const enriched = {...row, domain: batch.domain, batchRows: batch.rows.length, batchCounts: batch.counts};
      lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(enriched))).join(','));
    }
  }
  // BOM 让 Excel 正确识别 UTF-8 中文；解析方按标准 CSV 去掉即可。
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function exportAudit({dir, userId, url, now = new Date()} = {}) {
  const format = String(url.searchParams.get('format') || 'json').toLowerCase();
  if (format !== 'json' && format !== 'csv') throw new AuditQueryError('INVALID_FORMAT', '导出格式只支持 json 或 csv。', 400);
  const filters = parseAuditFilters(url.searchParams);
  const limit = clampLimit(url.searchParams.get('limit') || 200, 200);
  const view = readAudit({dir, userId, ...filters, limit});
  const filename = 'career-audit-' + stamp(now) + '.' + format;
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'X-Audit-Counts': JSON.stringify(view.counts)
  };
  if (format === 'csv') {
    return {status: 200, headers: {...headers, 'Content-Type': 'text/csv; charset=utf-8'}, body: toCsv(view.batches)};
  }
  const payload = {
    exportedAt: new Date(now).toISOString(),
    filters: view.filters,
    counts: view.counts,
    lastClearedAt: view.lastClearedAt,
    batches: view.batches
  };
  return {status: 200, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8'}, body: JSON.stringify(payload, null, 2)};
}

// 只删本人的 write_audit 与 confirmations；idempotency 保留到 TTL，跨用户零影响。
export function clearAudit({dir, userId, phrase} = {}) {
  if (String(phrase ?? '') !== CLEAR_PHRASE) throw new AuditQueryError('INVALID_PHRASE', '请输入「' + CLEAR_PHRASE + '」以确认清空。', 400);
  const clearedAt = new Date().toISOString();
  const counts = {domains: 0, batches: 0, rows: 0, confirmations: 0};
  for (const entry of AUDIT_DOMAINS) {
    const file = join(String(dir), entry.file);
    if (!existsSync(file)) continue;
    let db = null;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 5000');
      if (!hasAuditSchema(db)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        const batches = Number(db.prepare('SELECT COUNT(DISTINCT batch_id) c FROM write_audit WHERE user_id=?').get(String(userId)).c) || 0;
        const rows = Number(db.prepare('DELETE FROM write_audit WHERE user_id=?').run(String(userId)).changes) || 0;
        const confirmations = Number(db.prepare('DELETE FROM confirmations WHERE user_id=?').run(String(userId)).changes) || 0;
        db.prepare(`INSERT INTO audit_meta(domain, last_cleared_at, updated_at) VALUES(?,?,?)
          ON CONFLICT(domain) DO UPDATE SET last_cleared_at=excluded.last_cleared_at, updated_at=excluded.updated_at`)
          .run(entry.domain, clearedAt, clearedAt);
        db.exec('COMMIT');
        counts.domains += 1;
        counts.batches += batches;
        counts.rows += rows;
        counts.confirmations += confirmations;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
        throw error;
      }
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  // 还没有任何审计库时也要留下 last_cleared_at：清空本身是一次写操作，允许建最小的审计库骨架。
  if (!counts.domains && AUDIT_DOMAINS[0]) {
    const entry = AUDIT_DOMAINS[0];
    let db = null;
    try {
      db = new DatabaseSync(join(String(dir), entry.file));
      db.exec('PRAGMA busy_timeout = 5000');
      ensureAuditSchema(db, entry.domain);
      db.prepare('UPDATE audit_meta SET last_cleared_at=?, updated_at=? WHERE domain=?').run(clearedAt, clearedAt, entry.domain);
      counts.domains = 1;
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  return {ok: true, counts, clearedAt, lastClearedAt: counts.domains ? clearedAt : null};
}

function failure(error) {
  if (error instanceof AuditQueryError) return {json: {error: error.message, code: error.code}, status: error.status};
  return {json: {error: String(error?.message || error), code: 'AUDIT_FAILED'}, status: 500};
}

export async function handleAudit({dir, userId, url}) {
  try { return await handleAuditQuery({dir, userId, url}); } catch (error) { return failure(error); }
}

export function handleAuditExport({dir, userId, url}) {
  try { return exportAudit({dir, userId, url}); } catch (error) { return failure(error); }
}

export function handleAuditClear({dir, userId, body}) {
  try { return {json: clearAudit({dir, userId, phrase: body?.phrase}), status: 200}; } catch (error) { return failure(error); }
}

