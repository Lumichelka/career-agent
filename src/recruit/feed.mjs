// career_feed 契约：#56。信息流 = 规范化 events/projects/companies + 证据指针 + append-only cursor。
// 权威仍是本地审计库：cursor 用 write_audit.seq（AUTOINCREMENT，只增不减），不建 AI 私有库。
// 默认不返回原文；includeRawText 时脱敏（手机/邮箱/身份证/微信/联系人）并截断到 8k，绝不返回 HTML/截图字节。
import {existsSync, readdirSync, statSync} from 'node:fs';
import {join, basename, dirname, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hasAuditSchema} from '../writes/audit-store.mjs';

export const FEED_SCHEMA_VERSION = 'career_feed.v1';
export const FEED_RAW_TEXT_LIMIT = 8000;
export const EVIDENCE_TTL_MS = 30 * 24 * 3600 * 1000;
export const FEED_TYPES = ['event', 'project', 'company'];
const TYPE_ALIASES = {event: 'event', events: 'event', project: 'project', projects: 'project', company: 'company', companies: 'company'};
const ENTITY_TYPES = {events: 'event', event_projects: 'project'};
const MAX_LIMIT = 200;

function inputError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

export function normalizeTypes(types) {
  if (types === undefined || types === null) return [...FEED_TYPES];
  const list = Array.isArray(types) ? types : typeof types === 'string' ? types.split(',') : null;
  if (!list) throw inputError('types 必须是类型数组');
  const out = [];
  for (const raw of list) {
    const type = TYPE_ALIASES[String(raw ?? '').trim().toLowerCase()];
    if (!type) throw inputError('types 只支持 event/project/company；收到 ' + String(raw ?? ''));
    if (!out.includes(type)) out.push(type);
  }
  if (!out.length) throw inputError('types 至少需要一个类型');
  return out;
}

// HTML 实体解码必须在去标签之前：否则 &lt;b&gt; 这类转义会绕过标签清理，
// &#49;38... 这类数字实体也会绕过手机号/身份证脱敏。只解常见命名实体与数字实体。
function decodePoint(value) {
  try { return String.fromCodePoint(Number(value)); } catch { return ''; }
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => decodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, dec) => decodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

// 原文脱敏：先解 HTML 实体，再删脚本/样式与标签，再抹联系方式（含空格/连字符变体），最后截断。
export function sanitizeRawText(value) {
  let text = decodeHtmlEntities(value);
  if (!text) return '';
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  // 手机号：11 位；允许 138 0013 8000 / 138-0013-8000 这类排版。
  text = text.replace(/(?<!\d)1[3-9]\d(?:[\s-]?\d{4}){2}(?!\d)/g, '***');
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***');
  // 身份证：18 位（末位 X）与 15 位；同样允许分组空格/连字符。
  text = text.replace(/(?<!\d)\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?!\d)/g, '***');
  text = text.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '***');
  text = text.replace(/(?<!\d)\d{6}[\s-]?\d{6}[\s-]?\d{3}(?!\d)/g, '***');
  text = text.replace(/(?<!\d)\d{15}(?!\d)/g, '***');
  // 微信：带“微信/wechat/wx”前缀的号，以及裸的 wxid_ 标识。
  text = text.replace(/((?:微信|wechat|weixin|wx|vx)\s*(?:号|id)?\s*[:：=]?\s*)([A-Za-z][-_A-Za-z0-9]{5,19})/gi, '$1***');
  text = text.replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/gi, '***');
  text = text.replace(/(联系人\s*[:：]?\s*)([^\s，,。;；\n]{1,20})/g, '$1***');
  text = text.replace(/((?:联系电话|电话|手机号|手机|tel)\s*[:：]?\s*)(\+?\d[\d\s-]{6,})/gi, '$1***');
  text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > FEED_RAW_TEXT_LIMIT ? text.slice(0, FEED_RAW_TEXT_LIMIT) : text;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function iso(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

const DELETED_STATUS = new Set(['removed', 'archived', 'cancelled', 'orphaned', 'deleted']);

function deletedAtFor(status, updatedAt, occurredAt) {
  return DELETED_STATUS.has(String(status || '').toLowerCase()) ? (iso(updatedAt) || iso(occurredAt)) : null;
}

function eventRecord(row) {
  return {
    id: String(row.id || ''),
    type: 'event',
    title: String(row.title || ''),
    company: String(row.company || ''),
    school: String(row.school || ''),
    city: String(row.city || ''),
    kind: String(row.kind || ''),
    start_at: String(row.start_at || ''),
    end_at: String(row.end_at || ''),
    venue: String(row.venue || ''),
    positions: String(row.positions || ''),
    requirements: String(row.requirements || ''),
    apply_mode: String(row.apply_mode || ''),
    apply_url: String(row.apply_url || ''),
    status: String(row.status || 'active'),
    source_id: String(row.source_id || ''),
    source_url: String(row.source_url || ''),
    fetched_at: iso(row.fetched_at),
    confidence: num(row.confidence),
    verification: row.verified ? 'verified' : 'unverified',
    operation_id: '',
    evidence_ref: null,
    evidence_available: false,
    schema_version: FEED_SCHEMA_VERSION,
    updated_at: iso(row.last_seen_at || row.fetched_at),
    deleted_at: deletedAtFor(row.status, row.last_seen_at || row.fetched_at)
  };
}

function projectRecord(row) {
  return {
    id: String(row.id || ''),
    type: 'project',
    event_id: row.event_id ? String(row.event_id) : null,
    company: String(row.company || ''),
    title: String(row.title || ''),
    positions: String(row.positions || ''),
    requirements: String(row.requirements || ''),
    apply_mode: String(row.apply_mode || ''),
    apply_url: String(row.apply_url || ''),
    platform: String(row.platform || ''),
    city: String(row.city || ''),
    status: String(row.status || 'active'),
    source_id: String(row.source_id || ''),
    source_url: String(row.source_url || ''),
    fetched_at: iso(row.fetched_at || row.updated_at),
    confidence: num(row.confidence, 0.8),
    verification: 'unverified',
    operation_id: '',
    evidence_ref: null,
    evidence_available: false,
    schema_version: FEED_SCHEMA_VERSION,
    updated_at: iso(row.updated_at || row.last_seen_at),
    deleted_at: deletedAtFor(row.status, row.updated_at || row.last_seen_at)
  };
}

function companyRecord(row) {
  let sources = [];
  try { sources = JSON.parse(row.sources_json || '[]'); } catch { sources = []; }
  const list = Array.isArray(sources) ? sources : [];
  return {
    id: String(row.id || ''),
    type: 'company',
    name: String(row.name || ''),
    industry: String(row.industry || ''),
    size: String(row.size || ''),
    city: String(row.city || ''),
    website: String(row.website || ''),
    summary: String(row.summary || ''),
    source_id: 'company',
    source_url: String(list[0]?.url || ''),
    fetched_at: iso(row.updated_at || row.created_at),
    confidence: 0.5,
    verification: 'unverified',
    operation_id: '',
    evidence_ref: null,
    evidence_available: false,
    schema_version: FEED_SCHEMA_VERSION,
    updated_at: iso(row.updated_at || row.created_at),
    deleted_at: null
  };
}

function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

// 审计投影是 camelCase；行已被撤销删除时用它还原一条 markdown 记录，保证下游看见 deleted_at。
function eventRowFromValues(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    id: v.id, source_id: v.sourceId, school: v.school, city: v.city, kind: v.kind, title: v.title,
    company: v.company, start_at: v.startAt, end_at: v.endAt, venue: v.venue, positions: v.positions,
    requirements: v.requirements, apply_mode: v.applyMode, apply_url: v.applyUrl, source_url: v.sourceUrl,
    fetched_at: v.fetchedAt, confidence: v.confidence, verified: v.verified, status: v.status,
    last_seen_at: v.lastSeenAt
  };
}

function projectRowFromValues(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    id: v.id, event_id: v.eventId, company: v.company, title: v.title, positions: v.positions,
    requirements: v.requirements, apply_mode: v.applyMode, apply_url: v.applyUrl, source_url: v.sourceUrl,
    source_id: v.sourceId, source_key: v.sourceKey, status: v.status, confidence: v.confidence,
    platform: v.platform, city: v.city, fetched_at: v.fetchedAt, updated_at: v.updatedAt,
    last_seen_at: v.lastSeenAt
  };
}

function safeSegment(value, max = 100) {
  const text = String(value || '');
  return /^[A-Za-z0-9._-]{1,100}$/.test(text) && text.length <= max ? text : '';
}

// 任务证据目录的装配约定：
// - 服务端根目录：<dataDir>/users/<userId>/tasks；
// - 用户 home：<dataDir>/tasks（仅当 dataDir 本身的 basename 就是 userId）；
// - 聊天租户：<dataDir> = .../users/<userId>/.data，证据在同级 users/<userId>/tasks。
// 只有能证明「用户目录 basename=userId」时才接受它；否则不猜、不向上跨越，
// 绝不让 dataDir/../tasks 把证据根带到别处（#54 评审 P0）。
function userTasksRoot(dataDir, userId) {
  const root = resolve(String(dataDir));
  const user = String(userId || '');
  if (!user) return null;
  let userDir;
  if (basename(root) === '.data' && basename(dirname(root)) === user) userDir = dirname(root);
  else if (basename(root) === user) userDir = root;
  else userDir = join(root, 'users', user);
  if (basename(userDir) !== user) return null;
  return join(userDir, 'tasks');
}

export function evidenceRoots(dataDir, userId) {
  if (!dataDir) return [];
  const userRoot = userTasksRoot(dataDir, userId);
  if (userRoot) return [userRoot];
  // 没有 userId：只接受 dataDir 自己的 tasks（不向上跨出）。
  return [join(resolve(String(dataDir)), 'tasks')];
}

// 证据指针只认 artifact:<file> 或 task:<taskId>；只检查本地证据文件是否存在/未过期，从不读取字节。
function evidenceMeta(auditRow, {dataDir, userId, now}) {
  const taskId = safeSegment(auditRow?.task_id);
  const raw = String(auditRow?.source_ref || '').trim();
  const roots = taskId ? evidenceRoots(dataDir, userId) : [];
  const dirs = roots.map(root => join(root, taskId, 'evidence'));
  let ref = null;
  let path = null;
  if (raw.startsWith('artifact:')) {
    const file = safeSegment(basename(raw.slice('artifact:'.length).split(/[\\/]/).pop()));
    if (file && taskId) {
      ref = 'artifact:' + file;
      path = dirs.map(dir => join(dir, file)).find(candidate => existsSync(candidate)) || (dirs[0] ? join(dirs[0], file) : null);
    }
  } else if (taskId) {
    ref = 'task:' + taskId;
    path = dirs.find(dir => existsSync(dir)) || dirs[0] || null;
  }
  let available = false;
  if (path && existsSync(path)) {
    try {
      if (ref.startsWith('artifact:')) {
        available = now - statSync(path).mtimeMs <= EVIDENCE_TTL_MS;
      } else {
        // task 指针指向整个证据目录：目录里至少还有一个未过期的文件才算可用（清理后目录可能仍在）。
        available = readdirSync(path).some(file => {
          try { return now - statSync(join(path, file)).mtimeMs <= EVIDENCE_TTL_MS; } catch { return false; }
        });
      }
    } catch { available = false; }
  }
  // operation_id = taskId:runSeq（#54 评审）：runSeq 用该审计行的 seq，保证同任务多次写入可区分，
  // 且与 cursor 同源、只增不减。没有审计行就没有 operation_id。
  const runSeq = Number(auditRow?.seq) || 0;
  return {operationId: taskId ? taskId + ':' + runSeq : '', evidenceRef: ref, evidenceAvailable: available};
}

function applyAuditMeta(record, auditRow, artifactRow, options) {
  if (auditRow) record.operation_id = evidenceMeta(auditRow, options).operationId;
  // 证据跟随产生这条数据的那次 artifact 写入：删除/撤销不抹掉原证据指针。
  const evidence = artifactRow ? evidenceMeta(artifactRow, options) : auditRow ? evidenceMeta(auditRow, options) : null;
  record.evidence_ref = evidence?.evidenceRef || null;
  record.evidence_available = evidence?.evidenceAvailable === true;
  return record;
}

function maxAuditSeq(db, userId) {
  if (!userId) return 0;
  let high = 0;
  // AUTOINCREMENT 的 sqlite_sequence 在 DELETE 后仍保留最大已分配 seq：审计清空后 cursor 也不倒退。
  try {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='write_audit'").get();
    high = Number(row?.seq) || 0;
  } catch { /* 旧库或没有 AUTOINCREMENT 记录 */ }
  try {
    const row = db.prepare('SELECT MAX(seq) AS seq FROM write_audit WHERE user_id=?').get(String(userId));
    high = Math.max(high, Number(row?.seq) || 0);
  } catch { /* 审计表还不存在 */ }
  return high;
}

// 每个实体最后一次审计行：快照条目的 seq/operation_id 来自它。
function latestAuditRows(db, userId, artifactOnly = false) {
  const map = new Map();
  if (!userId) return map;
  try {
    const condition = artifactOnly ? " AND w.source_ref LIKE 'artifact:%'" : '';
    const rows = db.prepare(`SELECT w.* FROM write_audit w WHERE w.user_id=?${condition} AND w.seq=(
      SELECT MAX(x.seq) FROM write_audit x WHERE x.user_id=w.user_id AND x.entity=w.entity AND x.entity_id=w.entity_id
        ${artifactOnly ? "AND x.source_ref LIKE 'artifact:%'" : ''}
    )`).all(String(userId));
    for (const row of rows) map.set(String(row.entity) + ':' + String(row.entity_id), row);
  } catch { /* 旧库还没有审计表：当作没有审计信息 */ }
  return map;
}

function readCompanies({companyDir, dataDir, types, sourceFilter, options}) {
  if (!types.includes('company')) return [];
  const dirs = [companyDir, dataDir].filter(Boolean);
  let file = '';
  for (const dir of dirs) {
    const candidate = join(String(dir), 'company.db');
    if (existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) return [];
  let db = null;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.prepare('SELECT * FROM companies').all();
    const out = [];
    for (const row of rows) {
      const record = companyRecord(row);
      if (sourceFilter && record.source_id !== sourceFilter) continue;
      out.push({seq: 0, op: 'upsert', type: 'company', id: record.id, record, changed_at: record.updated_at || record.fetched_at || ''});
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

function snapshotEntries({db, companyDir, dataDir, userId, types, sourceFilter, includeRawText, options}) {
  const latest = hasAuditSchema(db) ? latestAuditRows(db, userId) : new Map();
  const artifacts = hasAuditSchema(db) ? latestAuditRows(db, userId, true) : new Map();
  const entries = [];
  const auditFor = (entity, id) => latest.get(entity + ':' + id) || null;
  const artifactFor = (entity, id) => artifacts.get(entity + ':' + id) || null;
  if (types.includes('event')) {
    const rows = db.prepare("SELECT * FROM events WHERE status NOT IN ('archived','orphaned')").all();
    for (const row of rows) {
      const record = applyAuditMeta(eventRecord(row), auditFor('events', row.id), artifactFor('events', row.id), options);
      if (sourceFilter && record.source_id !== sourceFilter) continue;
      const audit = auditFor('events', row.id);
      const entry = {seq: Number(audit?.seq) || 0, op: 'upsert', type: 'event', id: record.id, record, changed_at: record.updated_at || record.fetched_at || ''};
      if (includeRawText) {
        const text = sanitizeRawText(row.raw_text);
        if (text) entry.rawText = text;
      }
      entries.push(entry);
    }
  }
  if (types.includes('project')) {
    const rows = db.prepare("SELECT * FROM event_projects WHERE status != 'removed'").all();
    for (const row of rows) {
      const record = applyAuditMeta(projectRecord(row), auditFor('event_projects', row.id), artifactFor('event_projects', row.id), options);
      if (sourceFilter && record.source_id !== sourceFilter) continue;
      const audit = auditFor('event_projects', row.id);
      const entry = {seq: Number(audit?.seq) || 0, op: 'upsert', type: 'project', id: record.id, record, changed_at: record.updated_at || record.fetched_at || ''};
      if (includeRawText) {
        const text = sanitizeRawText(row.raw_text);
        if (text) entry.rawText = text;
      }
      entries.push(entry);
    }
  }
  entries.push(...readCompanies({companyDir, dataDir, types, sourceFilter, options}));
  entries.sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')) || String(a.id).localeCompare(String(b.id)));
  return entries;
}

function incrementalEntries({db, dataDir, userId, since, types, sourceFilter, limit, includeRawText, options}) {
  const artifacts = hasAuditSchema(db) && userId ? latestAuditRows(db, userId, true) : new Map();
  const entities = [];
  if (types.includes('event')) entities.push('events');
  if (types.includes('project')) entities.push('event_projects');
  if (!entities.length || !hasAuditSchema(db) || !userId) return {entries: [], hasMore: false, maxSeq: maxAuditSeq(db, userId)};
  const marks = entities.map(() => '?').join(',');
  const collect = (row) => {
    const type = ENTITY_TYPES[row.entity];
    if (!type) return null;
    const table = type === 'event' ? 'events' : 'event_projects';
    const current = db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(String(row.entity_id)) || null;
    const values = parseJson(row.old_values) || parseJson(row.new_values) || null;
    let record;
    if (current) {
      record = type === 'event' ? eventRecord(current) : projectRecord(current);
    } else if (type === 'event') {
      record = eventRecord(eventRowFromValues(values));
      record.id = String(row.entity_id);
      record.updated_at = record.updated_at || iso(row.occurred_at);
      record.deleted_at = iso(row.occurred_at);
    } else {
      record = projectRecord(projectRowFromValues(values));
      record.id = String(row.entity_id);
      record.updated_at = record.updated_at || iso(row.occurred_at);
      record.deleted_at = iso(row.occurred_at);
    }
    applyAuditMeta(record, row, artifacts.get(String(row.entity) + ':' + String(row.entity_id)) || null, options);
    if (sourceFilter && record.source_id !== sourceFilter) return null;
    const op = row.undo_of ? 'undo' : row.action === 'delete' ? 'delete' : 'upsert';
    const entry = {
      seq: Number(row.seq),
      op,
      type,
      id: String(row.entity_id),
      record,
      changed_at: iso(row.occurred_at) || ''
    };
    if (row.undo_of) entry.undo_of = row.undo_of;
    if (row.result && row.result !== 'applied') entry.result = row.result;
    if (includeRawText) {
      const source = current ? current.raw_text : values?.rawText;
      const text = sanitizeRawText(source);
      if (text) entry.rawText = text;
    }
    return entry;
  };
  let scan = since;
  const collected = [];
  let hasMore = false;
  for (;;) {
    const rows = db.prepare(`SELECT * FROM write_audit WHERE user_id=? AND seq>? AND entity IN (${marks}) ORDER BY seq ASC LIMIT 200`)
      .all(String(userId), scan, ...entities);
    if (!rows.length) break;
    for (const row of rows) {
      scan = Number(row.seq);
      const entry = collect(row);
      if (!entry) continue;
      collected.push(entry);
      if (collected.length > limit) { hasMore = true; break; }
    }
    if (hasMore || rows.length < 200) break;
  }
  return {entries: collected.slice(0, limit), hasMore, maxSeq: maxAuditSeq(db, userId)};
}

export function readFeed({db, companyDir = '', dataDir = '', userId = '', since, types, sourceId = '', limit = 50, includeRawText = false, now = Date.now(), offset = 0} = {}) {
  const normalizedTypes = normalizeTypes(types);
  const capped = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 50));
  const sourceFilter = String(sourceId || '').trim();
  const options = {dataDir, userId, now};
  if (since === undefined || since === null) {
    const start = Number(offset);
    if (!Number.isInteger(start) || start < 0) throw inputError('offset 必须是非负整数');
    const all = snapshotEntries({db, companyDir, dataDir, userId, types: normalizedTypes, sourceFilter, includeRawText: includeRawText === true, options});
    const maxSeq = hasAuditSchema(db) ? maxAuditSeq(db, userId) : 0;
    const entries = all.slice(start, start + capped);
    const hasMore = start + entries.length < all.length;
    return {
      status: 'readable',
      schema_version: FEED_SCHEMA_VERSION,
      mode: 'snapshot',
      entries,
      offset: start,
      // 快照被 limit 截断时 nextCursor 没有意义（跳到 maxSeq 会漏掉快照里剩余的条目）；
      // 用 nextOffset 继续取快照，等 hasMore=false 后 nextCursor 才是可用的增量起点。
      nextOffset: hasMore ? start + entries.length : null,
      nextCursor: hasMore ? null : Math.max(0, maxSeq),
      hasMore,
      count: entries.length
    };
  }
  if (offset !== undefined && offset !== 0) throw inputError('增量模式不支持 offset；用 nextCursor 继续');
  const sinceNumber = Number(since);
  if (!Number.isInteger(sinceNumber) || sinceNumber < 0) throw inputError('since 必须是非负整数');
  const {entries, hasMore, maxSeq} = incrementalEntries({
    db, dataDir, userId, since: sinceNumber, types: normalizedTypes, sourceFilter, limit: capped, includeRawText, options
  });
  const nextCursor = hasMore ? entries[entries.length - 1].seq : Math.max(sinceNumber, maxSeq);
  return {
    status: 'readable',
    schema_version: FEED_SCHEMA_VERSION,
    entries,
    nextCursor,
    hasMore,
    count: entries.length
  };
}
