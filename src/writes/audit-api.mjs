// GET /api/audit：按任务/批次读取当前用户自己的自动写入审计。
// 只读路径不建表：库还没发生过自动写入时，不留下任何审计痕迹。
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hasAuditSchema, listAuditBatches} from './audit-store.mjs';
import {WRITE_DOMAINS} from './domains.mjs';

// 每个自动写入域一个库；域清单与写网关共用，新增域只改 domains.mjs。
export const AUDIT_DOMAINS = WRITE_DOMAINS;

export function readAudit({dir, userId, taskId = '', batchId = '', limit = 50} = {}) {
  if (!dir || !userId) return {batches: [], counts: {batches: 0, rows: 0}, filters: {taskId, batchId, limit}};
  const batches = [];
  for (const entry of AUDIT_DOMAINS) {
    const file = join(dir, entry.file);
    if (!existsSync(file)) continue;
    let db = null;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 5000');
      if (!hasAuditSchema(db)) continue;
      batches.push(...listAuditBatches(db, {userId, taskId, batchId, limit, domain: entry.domain}));
    } catch {
      // 单个库读不出来不影响其它域；审计失败不伪造数据。
      continue;
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  batches.sort((a, b) => (b.rows.at(-1)?.seq || 0) - (a.rows.at(-1)?.seq || 0));
  const capped = batchId ? batches : batches.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  return {
    batches: capped,
    counts: {batches: capped.length, rows: capped.reduce((sum, batch) => sum + batch.rows.length, 0)},
    filters: {taskId, batchId, limit}
  };
}

export async function handleAudit({dir, userId, url}) {
  const taskId = String(url.searchParams.get('taskId') || '').trim();
  const batchId = String(url.searchParams.get('batchId') || '').trim();
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
  return {json: readAudit({dir, userId, taskId, batchId, limit})};
}
