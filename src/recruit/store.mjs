// 本地数据层：node:sqlite（Node 内置，无第三方依赖）。
// 存三样东西：原始页面（可追溯）、结构化活动、每次采集的运行记录。
let DatabaseSync;
try {
  ({DatabaseSync} = await import('node:sqlite'));
} catch {
  throw new Error('当前 Node 版本不支持内置 SQLite（node:sqlite）。请升级到 Node 23+，或在 Node 22 上加 --experimental-sqlite 启动。');
}
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
import {normalizePlatformJobs} from './platform-jobs.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, name TEXT, school TEXT, city TEXT, category TEXT, channel TEXT,
  list_url TEXT, mode TEXT, enabled INTEGER, note TEXT, orphaned INTEGER DEFAULT 0,
  last_run TEXT, last_status TEXT, last_error TEXT, last_count INTEGER DEFAULT 0,
  failure_streak INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, source_id TEXT, school TEXT, city TEXT, kind TEXT,
  title TEXT, company TEXT, start_at TEXT, end_at TEXT,
  venue TEXT, address TEXT, industry TEXT, company_size TEXT,
  positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT,
  source_url TEXT, published_at TEXT, fetched_at TEXT,
  confidence REAL DEFAULT 0.5, verified INTEGER DEFAULT 0, raw_text TEXT, notes TEXT,
  interview_stage TEXT DEFAULT '', interview_type TEXT DEFAULT '',
  status TEXT DEFAULT 'active', first_seen_at TEXT, last_seen_at TEXT,
  missing_runs INTEGER DEFAULT 0, cross_sources TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, finished_at TEXT,
  status TEXT, fetched INTEGER, created INTEGER, updated INTEGER, message TEXT
);
-- 平台岗位（#51）不绑定线下活动：event_id 允许为空，来源链接/抓取时间/置信度随项目保存。
CREATE TABLE IF NOT EXISTS event_projects(
  id TEXT PRIMARY KEY, event_id TEXT, company TEXT, title TEXT,
  positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT,
  source_url TEXT, notes TEXT, source_id TEXT, source_key TEXT,
  status TEXT DEFAULT 'active', confidence REAL DEFAULT 0.8,
  first_seen_at TEXT, last_seen_at TEXT, missing_runs INTEGER DEFAULT 0,
  raw_text TEXT, created_at TEXT, updated_at TEXT,
  platform TEXT, city TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS raw_pages(
  url TEXT PRIMARY KEY, source_id TEXT, title TEXT, text TEXT, fetched_at TEXT, hash TEXT
);
-- 来源校对：最近一次手动浏览器读取与原因；与采集器的 last_run/last_status 分开存，互不覆盖。
CREATE TABLE IF NOT EXISTS source_manual_reads(
  source_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, at TEXT, status TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_school ON events(school);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
-- 平台岗位的部分唯一索引不在这里建：旧库可能还没有 source_id/source_key 列，
-- 必须等 migrateProjects() 补列之后再建（见下方 migrateProjects）。
`;

// 旧库升级：只加列，不改历史数据。
const MIGRATIONS = [
  ['status', "TEXT DEFAULT 'active'"],
  ['first_seen_at', 'TEXT'],
  ['last_seen_at', 'TEXT'],
  ['missing_runs', 'INTEGER DEFAULT 0'],
  ['cross_sources', "TEXT DEFAULT ''"],
  ['interview_stage', "TEXT DEFAULT ''"],
  ['interview_type', "TEXT DEFAULT ''"]
];

// 采集结果里「成功」指源可访问并完成解析（哪怕 0 条或项目阶段失败）；失败/禁用不更新最近成功。
function isSuccessful(status) {
  return ['ok', 'empty', 'list_only'].includes(String(status || ''));
}

export class RecruitStore {
  constructor(file) {
    mkdirSync(dirname(file), {recursive: true});
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  static open(file) { return new RecruitStore(file); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  migrate() {
    const scolumns = new Set(this.db.prepare('PRAGMA table_info(sources)').all().map(r => r.name));
    if (!scolumns.has('orphaned')) this.db.exec('ALTER TABLE sources ADD COLUMN orphaned INTEGER DEFAULT 0');
    const columns = new Set(this.db.prepare('PRAGMA table_info(events)').all().map(r => r.name));
    for (const [name, ddl] of MIGRATIONS) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
    }
    this.db.exec("UPDATE events SET status='active' WHERE status IS NULL OR status=''");
    this.db.exec('UPDATE events SET first_seen_at=fetched_at WHERE first_seen_at IS NULL');
    this.db.exec('UPDATE events SET last_seen_at=fetched_at WHERE last_seen_at IS NULL');
    this.db.exec("UPDATE events SET cross_sources=source_id WHERE cross_sources IS NULL OR cross_sources=''");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)');
    this.migrateProjects();
    const scols = new Set(this.db.prepare('PRAGMA table_info(sources)').all().map(r => r.name));
    const sMig = [
      ['last_attempt', 'TEXT'], ['last_success', 'TEXT'],
      ['last_fetched', 'INTEGER DEFAULT 0'], ['last_created', 'INTEGER DEFAULT 0'], ['last_updated', 'INTEGER DEFAULT 0'],
      ['failure_streak', 'INTEGER DEFAULT 0']
    ];
    for (const [name, ddl] of sMig) {
      if (!scols.has(name)) this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${ddl}`);
    }
  }

  // 项目表升级：旧库的 event_id NOT NULL 约束会挡住平台岗位，按需重建表（拷回历史行，不丢数据）。
  migrateProjects() {
    const info = this.db.prepare('PRAGMA table_info(event_projects)').all();
    if (info.some(row => row.name === 'event_id' && Number(row.notnull) === 1)) this.rebuildProjectsTable(info);
    const pcols = new Set(this.db.prepare('PRAGMA table_info(event_projects)').all().map(r => r.name));
    const pMig = [
      ['source_id', 'TEXT'], ['source_key', 'TEXT'], ['status', "TEXT DEFAULT 'active'"],
      ['confidence', 'REAL DEFAULT 0.8'], ['first_seen_at', 'TEXT'], ['last_seen_at', 'TEXT'],
      ['missing_runs', 'INTEGER DEFAULT 0'], ['raw_text', 'TEXT'],
      ['platform', 'TEXT'], ['city', 'TEXT'], ['fetched_at', 'TEXT']
    ];
    for (const [name, ddl] of pMig) {
      if (!pcols.has(name)) this.db.exec(`ALTER TABLE event_projects ADD COLUMN ${name} ${ddl}`);
    }
    this.db.exec("UPDATE event_projects SET status='active' WHERE status IS NULL OR status=''");
    this.db.exec("UPDATE event_projects SET first_seen_at=created_at WHERE first_seen_at IS NULL");
    this.db.exec("UPDATE event_projects SET last_seen_at=updated_at WHERE last_seen_at IS NULL");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_projects_event ON event_projects(event_id)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_source ON event_projects(event_id, source_id, source_key)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_platform ON event_projects(source_id, source_key) WHERE event_id IS NULL');
  }

  rebuildProjectsTable(info) {
    const columns = new Set(info.map(row => row.name));
    const base = ['id', 'event_id', 'company', 'title', 'positions', 'requirements', 'apply_mode', 'apply_url', 'source_url', 'notes', 'source_id', 'source_key', 'status', 'confidence', 'first_seen_at', 'last_seen_at', 'missing_runs', 'raw_text', 'created_at', 'updated_at'];
    const copy = [...base, 'platform', 'city', 'fetched_at'].filter(name => columns.has(name));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DROP TABLE IF EXISTS event_projects_new');
      this.db.exec(`CREATE TABLE event_projects_new(
        id TEXT PRIMARY KEY, event_id TEXT, company TEXT, title TEXT,
        positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT,
        source_url TEXT, notes TEXT, source_id TEXT, source_key TEXT,
        status TEXT DEFAULT 'active', confidence REAL DEFAULT 0.8,
        first_seen_at TEXT, last_seen_at TEXT, missing_runs INTEGER DEFAULT 0,
        raw_text TEXT, created_at TEXT, updated_at TEXT,
        platform TEXT, city TEXT, fetched_at TEXT
      )`);
      this.db.exec(`INSERT INTO event_projects_new(${copy.join(',')}) SELECT ${copy.join(',')} FROM event_projects`);
      this.db.exec('DROP TABLE event_projects');
      this.db.exec('ALTER TABLE event_projects_new RENAME TO event_projects');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw error;
    }
  }

  // 对账注册表与 sources 表：注册表源保持 active；墓碑源与表里多出的源标 orphaned（保留历史行，不删除）。
  // 随后把孤儿源的历史活动标 orphaned，保证每条活动能追到当前或历史来源。幂等，可在每次打开/请求时执行。
  syncSources(sources, removed = []) {
    const upsert = this.db.prepare(`INSERT INTO sources(id,name,school,city,category,channel,list_url,mode,enabled,note,orphaned)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,school=excluded.school,city=excluded.city,
        category=excluded.category,channel=excluded.channel,list_url=excluded.list_url,mode=excluded.mode,
        enabled=excluded.enabled,note=excluded.note,orphaned=excluded.orphaned`);
    for (const s of sources) upsert.run(s.id, s.name, s.school, s.city, s.category, s.channel || '', s.listUrl, s.mode, s.enabled ? 1 : 0, s.note || '', 0);
    for (const s of removed) upsert.run(s.id, s.name, s.school, s.city, s.category, s.channel || '', s.listUrl, s.mode, 0, s.note || '', 1);
    // 表里还有但既不在注册表也不在墓碑里的源 → 标 orphaned（源码已移除但未登记墓碑），保留历史行。
    const known = new Set([...sources.map(s => s.id), ...removed.map(s => s.id)]);
    for (const row of this.db.prepare('SELECT id FROM sources').all()) {
      if (!known.has(row.id)) this.db.prepare('UPDATE sources SET orphaned=1, enabled=0 WHERE id=?').run(row.id);
    }
    this.markOrphanedEvents();
  }

  // 谱系迁移：主来源是孤儿源的活动标 orphaned（保留 cancelled；主源仍在的活动不标）。幂等。
  markOrphanedEvents() {
    const orphanIds = this.db.prepare('SELECT id FROM sources WHERE orphaned=1').all().map(r => r.id);
    if (!orphanIds.length) return 0;
    const marks = orphanIds.map(() => '?').join(',');
    const res = this.db.prepare("UPDATE events SET status='orphaned' WHERE source_id IN (" + marks + ") AND status NOT IN ('cancelled','orphaned')").run(...orphanIds);
    return Number(res.changes) || 0;
  }

  // 来源状态 + 派生新鲜度：最近尝试/成功时间、抓取/新增/更新数、数据年龄、是否超 24h 需刷新。
  sourceStates() {
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY category, school').all();
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const activeToday = this.db.prepare(
      "SELECT source_id, cross_sources FROM events WHERE substr(start_at, 1, 10)=? AND status NOT IN ('cancelled','archived')"
    ).all(today);
    const withEventsToday = new Set();
    for (const r of activeToday) {
      if (r.source_id) withEventsToday.add(r.source_id);
      for (const sid of String(r.cross_sources || '').split(',')) if (sid) withEventsToday.add(sid);
    }
    const now = Date.now();
    return rows.map(row => {
      const lastSuccessMs = row.last_success ? Date.parse(row.last_success) : NaN;
      const dataAgeMinutes = Number.isFinite(lastSuccessMs) ? Math.max(0, Math.floor((now - lastSuccessMs) / 60000)) : null;
      const stale = withEventsToday.has(row.id) && (dataAgeMinutes === null || dataAgeMinutes > 24 * 60);
      return {
        ...row,
        lastAttempt: row.last_attempt || '',
        lastSuccess: row.last_success || '',
        lastFetched: Number(row.last_fetched) || 0,
        lastCreated: Number(row.last_created) || 0,
        lastUpdated: Number(row.last_updated) || 0,
        failureStreak: Number(row.failure_streak) || 0,
        hasEventsToday: withEventsToday.has(row.id),
        stale,
        dataAgeMinutes
      };
    });
  }

  recordManualRead({sourceId, taskId = '', sessionId = '', status = 'succeeded', reason = ''}) {
    this.db.prepare(`INSERT INTO source_manual_reads(source_id,task_id,session_id,at,status,reason) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET task_id=excluded.task_id,session_id=excluded.session_id,at=excluded.at,status=excluded.status,reason=excluded.reason`)
      .run(String(sourceId), String(taskId || ''), String(sessionId || ''), new Date().toISOString(), String(status || ''), String(reason || '').slice(0, 200));
  }

  manualReads() {
    const rows = this.db.prepare('SELECT * FROM source_manual_reads').all();
    return Object.fromEntries(rows.map(row => [row.source_id, {
      sourceId: row.source_id,
      taskId: row.task_id || '',
      sessionId: row.session_id || '',
      at: row.at || '',
      status: row.status || '',
      reason: row.reason || ''
    }]));
  }

  markSource(id, {status, error = '', count = 0, fetched, created = 0, updated = 0}) {
    const now = new Date().toISOString();
    const f = Number(fetched ?? count) || 0;
    this.db.prepare('UPDATE sources SET last_run=?, last_status=?, last_error=?, last_count=?, last_attempt=? WHERE id=?')
      .run(now, status, error, f, now, id);
    if (isSuccessful(status)) {
      this.db.prepare('UPDATE sources SET last_success=?, last_fetched=?, last_created=?, last_updated=?, failure_streak=0 WHERE id=?')
        .run(now, f, Number(created) || 0, Number(updated) || 0, id);
    } else {
      // 连续失败：成功（ok/empty/list_only）清零，其余每次 +1；供来源卡与告警判断。
      this.db.prepare('UPDATE sources SET failure_streak=COALESCE(failure_streak,0)+1 WHERE id=?').run(id);
    }
  }

  saveRaw({url, sourceId, title, text}) {
    const hash = Buffer.from(text || '').length.toString(36) + '-' + (text || '').length;
    this.db.prepare(`INSERT INTO raw_pages(url,source_id,title,text,fetched_at,hash) VALUES(?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at,hash=excluded.hash`)
      .run(url, sourceId, title || '', (text || '').slice(0, 200000), new Date().toISOString(), hash);
  }

  // 同一活动再次出现：恢复 active、清零缺失计数、合并多源。
  upsertEvent(e) {
    const now = new Date().toISOString();
    const nextStatus = e.status === 'cancelled' ? 'cancelled' : 'active';
    const existing = this.db.prepare('SELECT * FROM events WHERE id=?').get(e.id);
    if (existing) {
      const cross = new Set(String(existing.cross_sources || existing.source_id || '').split(',').filter(Boolean));
      cross.add(e.sourceId);
      const crossSources = [...cross].join(',');
      const confidence = Math.min(0.95, Math.max(Number(existing.confidence) || 0, e.confidence ?? 0.5) + (cross.size > 1 ? 0.08 : 0));
      this.db.prepare(`UPDATE events SET source_id=?,school=?,city=?,kind=?,title=?,company=?,start_at=?,end_at=?,venue=?,address=?,industry=?,
        company_size=?,positions=?,requirements=?,apply_mode=?,apply_url=?,source_url=?,published_at=?,fetched_at=?,
        confidence=?,raw_text=?,notes=?,interview_stage=?,interview_type=?,status=?,first_seen_at=?,last_seen_at=?,missing_runs=0,cross_sources=? WHERE id=?`)
        .run(e.sourceId, e.school || '', e.city || '', e.kind || '其他', e.title, e.company || '', e.startAt, e.endAt || '', e.venue || '', e.address || '', e.industry || '',
          e.companySize || '', e.positions || '', e.requirements || '', e.applyMode || '', e.applyUrl || '',
          e.sourceUrl || '', e.publishedAt || '', e.fetchedAt, confidence, (e.rawText || '').slice(0, 20000), e.notes || '',
          e.interviewStage || existing.interview_stage || '', e.interviewType || existing.interview_type || '',
          nextStatus, existing.first_seen_at || now, now, crossSources, e.id);
      return 'updated';
    }
    this.db.prepare(`INSERT INTO events(id,source_id,school,city,kind,title,company,start_at,end_at,venue,address,
      industry,company_size,positions,requirements,apply_mode,apply_url,source_url,published_at,fetched_at,confidence,verified,raw_text,notes,
      interview_stage,interview_type,
      status,first_seen_at,last_seen_at,missing_runs,cross_sources)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, e.sourceId, e.school || '', e.city || '', e.kind || '其他', e.title, e.company || '', e.startAt, e.endAt || '',
        e.venue || '', e.address || '', e.industry || '', e.companySize || '', e.positions || '', e.requirements || '',
        e.applyMode || '', e.applyUrl || '', e.sourceUrl || '', e.publishedAt || '', e.fetchedAt, e.confidence ?? 0.5, 0,
        (e.rawText || '').slice(0, 20000), e.notes || '', e.interviewStage || '', e.interviewType || '',
        nextStatus, now, now, 0, e.sourceId);
    return 'created';
  }

  // 本次没出现的活动：累计缺失；连续 3 次标记"可能撤下"（多源活动跳过，避免误伤）。
  markMissing(sourceId, seenIds) {
    const seen = new Set(seenIds);
    const rows = this.db.prepare("SELECT id, missing_runs, cross_sources FROM events WHERE status='active' AND (source_id=? OR cross_sources LIKE ?)").all(sourceId, '%' + sourceId + '%');
    let checked = 0, hidden = 0, skipped = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if (String(row.cross_sources || '').includes(',')) { skipped++; continue; }
      checked++;
      const missing = (Number(row.missing_runs) || 0) + 1;
      const status = missing >= 3 ? 'possibly_removed' : 'active';
      this.db.prepare('UPDATE events SET missing_runs=?, status=? WHERE id=?').run(missing, status, row.id);
      if (status === 'possibly_removed') hidden++;
    }
    return {checked, hidden, skipped};
  }

  setVerified(id, verified = 1, notes = '') {
    this.db.prepare('UPDATE events SET verified=?, notes=? WHERE id=?').run(verified ? 1 : 0, notes, id);
  }

  listEvents({from, to, limit = 200, school, kind, includeCancelled = false, withProjects = false} = {}) {
    const where = [], args = [];
    if (from) { where.push('start_at >= ?'); args.push(from); }
    if (to) { where.push('start_at <= ?'); args.push(to); }
    if (school) { where.push('school = ?'); args.push(school); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (includeCancelled) where.push("status != 'archived'"); else where.push("status NOT IN ('cancelled','archived')");
    const sql = 'SELECT * FROM events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY start_at ASC LIMIT ?';
    const events = this.db.prepare(sql).all(...args, limit).map(rowToEvent);
    if (withProjects && events.length) {
      const ids = events.map(e => e.id);
      const rows = this.db.prepare(`SELECT * FROM event_projects WHERE event_id IN (${ids.map(() => '?').join(',')}) AND status!='removed' ORDER BY created_at ASC`).all(...ids);
      const byEvent = new Map();
      for (const row of rows) {
        if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
        byEvent.get(row.event_id).push(rowToProject(row));
      }
      for (const e of events) e.projects = byEvent.get(e.id) || [];
    }
    return events;
  }

  listProjects(eventId) {
    return this.db.prepare('SELECT * FROM event_projects WHERE event_id=? ORDER BY created_at ASC').all(eventId).map(rowToProject);
  }

  // 高频单位：合并活动与项目里的单位名，按出现次数降序、名称升序排列。
  // 排除取消/归档的活动、已移除的项目与空单位名；同名只做 TRIM 归并，不做简称/全称归一。
  unitNameCounts({limit = 100} = {}) {
    const rows = this.db.prepare(`
      SELECT name, SUM(c) AS count FROM (
        SELECT TRIM(company) AS name, COUNT(*) AS c FROM events
          WHERE TRIM(company) != '' AND status NOT IN ('cancelled','archived') GROUP BY TRIM(company)
        UNION ALL
        SELECT TRIM(company) AS name, COUNT(*) AS c FROM event_projects
          WHERE TRIM(company) != '' AND status != 'removed' GROUP BY TRIM(company)
      ) GROUP BY name ORDER BY count DESC, name ASC LIMIT ?`).all(limit);
    return rows.map(r => ({name: r.name, count: Number(r.count) || 0}));
  }

  upsertProject(input) {
    const eventId = String(input.eventId || '');
    if (!eventId || !this.getEvent(eventId)) throw new Error('关联活动不存在');
    const company = String(input.company || '').trim().slice(0, 120);
    const title = String(input.title || '').trim().slice(0, 200);
    if (!company && !title) throw new Error('单位和项目名称至少填一项');
    const data = {
      company, title,
      positions: String(input.positions || '').trim().slice(0, 2000),
      requirements: String(input.requirements || '').trim().slice(0, 4000),
      applyMode: String(input.applyMode || '').trim().slice(0, 60),
      applyUrl: String(input.applyUrl || '').trim().slice(0, 500),
      sourceUrl: String(input.sourceUrl || '').trim().slice(0, 500),
      notes: String(input.notes || '').trim().slice(0, 2000),
      sourceId: input.sourceId ? String(input.sourceId).slice(0, 80) : null,
      sourceKey: input.sourceKey ? String(input.sourceKey).slice(0, 200) : null,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.8,
      rawText: String(input.rawText || '').slice(0, 4000)
    };
    const now = new Date().toISOString();
    if (input.id) {
      const existing = this.db.prepare('SELECT id FROM event_projects WHERE id=?').get(input.id);
      if (!existing) throw new Error('招聘项目不存在');
      this.db.prepare(`UPDATE event_projects SET company=?,title=?,positions=?,requirements=?,apply_mode=?,apply_url=?,source_url=?,notes=?,updated_at=?,last_seen_at=?,status='active',missing_runs=0 WHERE id=?`)
        .run(data.company, data.title, data.positions, data.requirements, data.applyMode, data.applyUrl, data.sourceUrl, data.notes, now, now, input.id);
      return rowToProject(this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(input.id));
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO event_projects(id,event_id,company,title,positions,requirements,apply_mode,apply_url,source_url,notes,source_id,source_key,status,confidence,first_seen_at,last_seen_at,missing_runs,raw_text,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, eventId, data.company, data.title, data.positions, data.requirements, data.applyMode, data.applyUrl, data.sourceUrl, data.notes,
        data.sourceId, data.sourceKey, 'active', data.confidence, now, now, 0, data.rawText, now, now);
    return rowToProject(this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(id));
  }

  // 来源同步：按 sourceKey 幂等；手工项目（source_id 为空）永不删除。
  // 每次增改/软删除都返回 changes，供写网关在同一事务里写审计。
  syncProjects(eventId, sourceId, projects) {
    if (!eventId || !sourceId) throw new Error('项目和来源必填');
    const now = new Date().toISOString();
    const seen = [];
    const changes = [];
    const result = {created: 0, updated: 0, kept: 0, removed: 0, total: 0, changes};
    for (const p of (projects || []).slice(0, 500)) {
      const company = String(p.company || '').trim().slice(0, 120);
      const title = String(p.title || '').trim().slice(0, 200);
      if (!company && !title) continue;
      const sourceKey = String(p.sourceKey || createHash('sha1').update([sourceId, company, title, p.sourceUrl || ''].join('|')).digest('hex').slice(0, 32));
      const existing = this.db.prepare('SELECT * FROM event_projects WHERE event_id=? AND source_id=? AND source_key=?').get(eventId, sourceId, sourceKey);
      if (existing) {
        this.db.prepare(`UPDATE event_projects SET company=?,title=?,positions=?,requirements=?,apply_mode=?,apply_url=?,source_url=?,notes=?,confidence=?,raw_text=?,status='active',missing_runs=0,last_seen_at=?,updated_at=? WHERE id=?`)
          .run(company, title, String(p.positions || '').slice(0, 2000), String(p.requirements || '').slice(0, 4000),
            String(p.applyMode || '').slice(0, 60), String(p.applyUrl || '').slice(0, 500), String(p.sourceUrl || '').slice(0, 500),
            String(p.notes || '').slice(0, 2000), Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : 0.8,
            String(p.rawText || '').slice(0, 4000), now, now, existing.id);
        const saved = this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(existing.id);
        changes.push({action: 'update', entity: 'event_projects', entityId: existing.id, oldValues: rowToProject(existing), newValues: rowToProject(saved), note: '来源项目同步'});
        result.updated++;
      } else {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO event_projects(id,event_id,company,title,positions,requirements,apply_mode,apply_url,source_url,notes,source_id,source_key,status,confidence,first_seen_at,last_seen_at,missing_runs,raw_text,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`)
          .run(id, eventId, company, title, String(p.positions || '').slice(0, 2000), String(p.requirements || '').slice(0, 4000),
            String(p.applyMode || '').slice(0, 60), String(p.applyUrl || '').slice(0, 500), String(p.sourceUrl || '').slice(0, 500),
            String(p.notes || '').slice(0, 2000), sourceId, sourceKey, 'active',
            Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : 0.8, now, String(p.rawText || '').slice(0, 4000), now, now);
        const saved = this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(id);
        changes.push({action: 'create', entity: 'event_projects', entityId: id, oldValues: null, newValues: rowToProject(saved), note: '来源项目同步'});
        result.created++;
      }
      seen.push(sourceKey);
    }
    const rows = this.db.prepare("SELECT id,missing_runs FROM event_projects WHERE event_id=? AND source_id=? AND status='active'").all(eventId, sourceId);
    for (const row of rows) {
      const key = this.db.prepare('SELECT source_key FROM event_projects WHERE id=?').get(row.id)?.source_key;
      if (seen.includes(key)) continue;
      const missing = (Number(row.missing_runs) || 0) + 1;
      if (missing >= 3) {
        const before = this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(row.id);
        this.db.prepare('UPDATE event_projects SET missing_runs=?,status=?,last_seen_at=? WHERE id=?').run(missing, 'removed', now, row.id);
        const after = this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(row.id);
        changes.push({action: 'delete', entity: 'event_projects', entityId: row.id, oldValues: rowToProject(before), newValues: rowToProject(after), note: '连续 3 次未出现，软删除'});
        result.removed++;
      } else {
        this.db.prepare('UPDATE event_projects SET missing_runs=?,status=?,last_seen_at=? WHERE id=?').run(missing, 'active', now, row.id);
      }
    }
    result.total = seen.length;
    return result;
  }

  // 平台岗位（#51）：来源键幂等写入，不绑定线下活动；只增改、不因本次少抓而删除。
  savePlatformJobs(input) {
    const {changes, result} = savePlatformJobRows({db: this.db, payload: input || {}});
    return {...result, changes};
  }

  // 平台岗位筛选：岗位/单位关键词、城市、平台；按抓取时间倒序。
  listPlatformJobs({q = '', city = '', platform = '', limit = 50} = {}) {
    const where = ["event_id IS NULL", "status != 'removed'", "source_id LIKE 'platform:%'"];
    const args = [];
    if (platform) { where.push('platform = ?'); args.push(String(platform)); }
    if (city) { where.push('city LIKE ?'); args.push('%' + String(city) + '%'); }
    const keyword = String(q || '').trim();
    if (keyword) {
      where.push('(company LIKE ? OR title LIKE ? OR positions LIKE ? OR requirements LIKE ?)');
      const like = '%' + keyword + '%';
      args.push(like, like, like, like);
    }
    const capped = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db.prepare('SELECT * FROM event_projects WHERE ' + where.join(' AND ') + ' ORDER BY fetched_at DESC, created_at DESC LIMIT ?')
      .all(...args, capped).map(rowToProject);
  }

  deleteProject(id) {
    this.db.prepare('DELETE FROM event_projects WHERE id=?').run(id);
  }

  getEvent(id) {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
    return row ? rowToEvent(row) : null;
  }

  getProject(id) {
    const row = this.db.prepare('SELECT * FROM event_projects WHERE id=?').get(id);
    return row ? rowToProject(row) : null;
  }

  recordRun(run) {
    this.db.prepare('INSERT INTO runs(id,source_id,started_at,finished_at,status,fetched,created,updated,message) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.sourceId, run.startedAt, run.finishedAt, run.status, run.fetched || 0, run.created || 0, run.updated || 0, run.message || '');
  }

  recentRuns(limit = 30) {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  stats() {
    const day = new Date().toISOString().slice(0, 10);
    const total = this.db.prepare("SELECT COUNT(*) c FROM events WHERE status NOT IN ('cancelled','archived')").get().c;
    const upcoming = this.db.prepare("SELECT COUNT(*) c FROM events WHERE start_at >= ? AND status NOT IN ('cancelled','archived')").get(day).c;
    const bySchool = this.db.prepare("SELECT school, COUNT(*) c FROM events WHERE status NOT IN ('cancelled','archived') GROUP BY school ORDER BY c DESC").all();
    const byKind = this.db.prepare("SELECT kind, COUNT(*) c FROM events WHERE status NOT IN ('cancelled','archived') GROUP BY kind ORDER BY c DESC").all();
    const byStatus = Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) c FROM events GROUP BY status').all().map(r => [r.status, r.c]));
    const projects = this.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c;
    const platformProjects = this.db.prepare("SELECT COUNT(*) c FROM event_projects WHERE event_id IS NULL AND source_id LIKE 'platform:%' AND status != 'removed'").get().c;
    return {total, upcoming, bySchool, byKind, byStatus, projects, platformProjects};
  }
}

// 平台岗位落库：调用方负责事务（写网关）或直接传 RecruitStore 的连接。
// 来源键幂等；已存在则更新并恢复 active，历史 first_seen_at 保留。
export function savePlatformJobRows({db, payload, normalized: preset}) {
  const normalized = preset || normalizePlatformJobs(payload || {});
  if (normalized.error) throw new Error(normalized.error);
  const sourceId = 'platform:' + normalized.platform;
  const now = new Date().toISOString();
  const changes = [];
  let created = 0, updated = 0;
  for (const job of normalized.jobs) {
    const previousRow = db.prepare('SELECT * FROM event_projects WHERE event_id IS NULL AND source_id=? AND source_key=?').get(sourceId, job.sourceKey);
    if (previousRow) {
      const existing = rowToProject(previousRow);
      db.prepare(`UPDATE event_projects SET company=?,title=?,positions=?,requirements=?,source_url=?,notes=?,confidence=?,raw_text=?,
        platform=?,city=?,fetched_at=?,status='active',missing_runs=0,last_seen_at=?,updated_at=? WHERE id=?`)
        .run(job.company, job.title, job.positions, job.requirements, job.sourceUrl, job.notes, job.confidence, job.rawText,
          normalized.platform, job.city, job.fetchedAt, job.fetchedAt, now, existing.id);
      const saved = rowToProject(db.prepare('SELECT * FROM event_projects WHERE id=?').get(existing.id));
      changes.push({action: 'update', entity: 'event_projects', entityId: saved.id, oldValues: existing, newValues: saved, note: '平台岗位入库'});
      updated++;
      continue;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO event_projects(id,event_id,company,title,positions,requirements,apply_mode,apply_url,source_url,notes,
      source_id,source_key,status,confidence,first_seen_at,last_seen_at,missing_runs,raw_text,created_at,updated_at,platform,city,fetched_at)
      VALUES(?,NULL,?,?,?,?,'','',?,?,?,?,'active',?,?,?,0,?,?,?,?,?,?)`)
      .run(id, job.company, job.title, job.positions, job.requirements, job.sourceUrl, job.notes, sourceId, job.sourceKey,
        job.confidence, job.fetchedAt, job.fetchedAt, job.rawText, now, now, normalized.platform, job.city, job.fetchedAt);
    const saved = rowToProject(db.prepare('SELECT * FROM event_projects WHERE id=?').get(id));
    changes.push({action: 'create', entity: 'event_projects', entityId: saved.id, oldValues: null, newValues: saved, note: '平台岗位入库'});
    created++;
  }
  return {
    changes,
    result: {platform: normalized.platform, sourceId, created, updated, skipped: normalized.skipped, total: normalized.jobs.length}
  };
}

function rowToEvent(r) {
  return {
    id: r.id, sourceId: r.source_id, school: r.school, city: r.city, kind: r.kind,
    title: r.title, company: r.company, startAt: r.start_at, endAt: r.end_at,
    venue: r.venue, address: r.address, industry: r.industry, companySize: r.company_size,
    positions: r.positions, requirements: r.requirements, applyMode: r.apply_mode, applyUrl: r.apply_url,
    sourceUrl: r.source_url, publishedAt: r.published_at, fetchedAt: r.fetched_at,
    confidence: r.confidence, verified: !!r.verified, rawText: r.raw_text, notes: r.notes,
    interviewStage: r.interview_stage || '', interviewType: r.interview_type || '',
    status: r.status || 'active', firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    missingRuns: Number(r.missing_runs) || 0,
    crossSources: String(r.cross_sources || '').split(',').filter(Boolean)
  };
}

function rowToProject(r) {
  return {
    id: r.id, eventId: r.event_id || '', company: r.company, title: r.title,
    positions: r.positions, requirements: r.requirements,
    applyMode: r.apply_mode, applyUrl: r.apply_url,
    sourceUrl: r.source_url, notes: r.notes,
    sourceId: r.source_id || '', sourceKey: r.source_key || '',
    platform: r.platform || '', city: r.city || '', fetchedAt: r.fetched_at || '',
    status: r.status || 'active', confidence: Number(r.confidence) || 0.8,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    missingRuns: Number(r.missing_runs) || 0,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
