// 演示数据清理：不直接 DELETE 招聘活动；改为软删除（status=archived）并写 write_audit，
// 这样既能从默认列表消失，也能在审计/撤销里看到并恢复。只匹配 example.com/org/net 的来源链接。
import {randomUUID, createHash} from 'node:crypto';
import {join} from 'node:path';
import {RecruitStore} from './store.mjs';
import {ensureAuditSchema, insertAuditRow} from '../writes/audit-store.mjs';

const DEMO_URL_SQL = "source_url LIKE '%example.com/%' OR source_url LIKE '%example.org/%' OR source_url LIKE '%example.net/%'";

/**
 * 软删除来源链接属于示例域名的活动。
 * 返回 {removed, batchId, eventIds}；重复执行不会重复写审计（archived 不再命中）。
 */
export function purgeDemoRecruitEvents({dir, userId = 'cli', actorType = 'cli', actorRef = '', now = () => new Date().toISOString()} = {}) {
  if (!dir) throw new Error('演示数据清理需要数据目录');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const rows = store.db.prepare(`SELECT id FROM events WHERE (${DEMO_URL_SQL}) AND status NOT IN ('archived')`).all();
    if (!rows.length) return {removed: 0, batchId: '', eventIds: []};
    ensureAuditSchema(store.db, 'recruit');
    const batchId = randomUUID();
    const occurredAt = now();
    const eventIds = [];
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const before = store.getEvent(row.id);
        if (!before) continue;
        const notes = [before.notes, '演示数据已软删除（purge-demo，可在审计撤销）'].filter(Boolean).join('；');
        store.db.prepare("UPDATE events SET status='archived', notes=? WHERE id=?").run(notes, row.id);
        const after = store.getEvent(row.id);
        insertAuditRow(store.db, {
          eventId: randomUUID(),
          occurredAt,
          userId: String(userId || 'cli'),
          actorType: String(actorType || 'cli'),
          actorRef: String(actorRef || ''),
          tool: 'wechat_purge_demo',
          taskId: '',
          batchId,
          action: 'delete',
          entity: 'events',
          entityId: row.id,
          oldValues: JSON.stringify(before),
          newValues: JSON.stringify(after),
          sourceRef: '',
          idempotencyKey: 'purge-demo:' + row.id,
          requestFingerprint: createHash('sha256').update('purge-demo|' + row.id).digest('hex'),
          confirmId: '',
          confirmed: false,
          undoOf: '',
          result: 'applied',
          note: '演示数据软删除（非物理删除）'
        });
        eventIds.push(row.id);
      }
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw error;
    }
    return {removed: eventIds.length, batchId, eventIds};
  } finally { store.close(); }
}
