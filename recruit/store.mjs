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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, name TEXT, school TEXT, city TEXT, category TEXT, channel TEXT,
  list_url TEXT, mode TEXT, enabled INTEGER, note TEXT,
  last_run TEXT, last_status TEXT, last_error TEXT, last_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, source_id TEXT, school TEXT, city TEXT, kind TEXT,
  title TEXT, company TEXT, start_at TEXT, end_at TEXT,
  venue TEXT, address TEXT, industry TEXT, company_size TEXT,
  positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT,
  source_url TEXT, published_at TEXT, fetched_at TEXT,
  confidence REAL DEFAULT 0.5, verified INTEGER DEFAULT 0, raw_text TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, finished_at TEXT,
  status TEXT, fetched INTEGER, created INTEGER, updated INTEGER, message TEXT
);
CREATE TABLE IF NOT EXISTS raw_pages(
  url TEXT PRIMARY KEY, source_id TEXT, title TEXT, text TEXT, fetched_at TEXT, hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_school ON events(school);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
`;

export class RecruitStore {
  constructor(file) {
    mkdirSync(dirname(file), {recursive: true});
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  static open(file) { return new RecruitStore(file); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  syncSources(sources) {
    const stmt = this.db.prepare(`INSERT INTO sources(id,name,school,city,category,channel,list_url,mode,enabled,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,school=excluded.school,city=excluded.city,
        category=excluded.category,channel=excluded.channel,list_url=excluded.list_url,mode=excluded.mode,
        enabled=excluded.enabled,note=excluded.note`);
    for (const s of sources) stmt.run(s.id, s.name, s.school, s.city, s.category, s.channel || '', s.listUrl, s.mode, s.enabled ? 1 : 0, s.note || '');
  }

  sourceStates() {
    return this.db.prepare('SELECT * FROM sources ORDER BY category, school').all();
  }

  markSource(id, {status, error = '', count = 0}) {
    this.db.prepare('UPDATE sources SET last_run=?, last_status=?, last_error=?, last_count=? WHERE id=?')
      .run(new Date().toISOString(), status, error, count, id);
  }

  saveRaw({url, sourceId, title, text}) {
    const hash = Buffer.from(text || '').length.toString(36) + '-' + (text || '').length;
    this.db.prepare(`INSERT INTO raw_pages(url,source_id,title,text,fetched_at,hash) VALUES(?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at,hash=excluded.hash`)
      .run(url, sourceId, title || '', (text || '').slice(0, 200000), new Date().toISOString(), hash);
  }

  upsertEvent(e) {
    const existing = this.db.prepare('SELECT id, verified FROM events WHERE id=?').get(e.id);
    if (existing) {
      this.db.prepare(`UPDATE events SET source_id=?,school=?,city=?,kind=?,title=?,company=?,start_at=?,end_at=?,venue=?,address=?,industry=?,
        company_size=?,positions=?,requirements=?,apply_mode=?,apply_url=?,source_url=?,published_at=?,fetched_at=?,
        confidence=?,raw_text=?,notes=? WHERE id=?`)
        .run(e.sourceId, e.school || '', e.city || '', e.kind || '其他', e.title, e.company || '', e.startAt, e.endAt || '', e.venue || '', e.address || '', e.industry || '',
          e.companySize || '', e.positions || '', e.requirements || '', e.applyMode || '', e.applyUrl || '',
          e.sourceUrl || '', e.publishedAt || '', e.fetchedAt, e.confidence ?? 0.5, (e.rawText || '').slice(0, 20000), e.notes || '', e.id);
      return 'updated';
    }
    this.db.prepare(`INSERT INTO events(id,source_id,school,city,kind,title,company,start_at,end_at,venue,address,
      industry,company_size,positions,requirements,apply_mode,apply_url,source_url,published_at,fetched_at,confidence,verified,raw_text,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, e.sourceId, e.school || '', e.city || '', e.kind || '其他', e.title, e.company || '', e.startAt, e.endAt || '',
        e.venue || '', e.address || '', e.industry || '', e.companySize || '', e.positions || '', e.requirements || '',
        e.applyMode || '', e.applyUrl || '', e.sourceUrl || '', e.publishedAt || '', e.fetchedAt, e.confidence ?? 0.5, 0,
        (e.rawText || '').slice(0, 20000), e.notes || '');
    return 'created';
  }

  setVerified(id, verified = 1, notes = '') {
    this.db.prepare('UPDATE events SET verified=?, notes=? WHERE id=?').run(verified ? 1 : 0, notes, id);
  }

  listEvents({from, to, limit = 200, school, kind} = {}) {
    const where = [], args = [];
    if (from) { where.push('start_at >= ?'); args.push(from); }
    if (to) { where.push('start_at <= ?'); args.push(to); }
    if (school) { where.push('school = ?'); args.push(school); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    const sql = 'SELECT * FROM events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY start_at ASC LIMIT ?';
    return this.db.prepare(sql).all(...args, limit).map(rowToEvent);
  }

  getEvent(id) {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
    return row ? rowToEvent(row) : null;
  }

  recordRun(run) {
    this.db.prepare('INSERT INTO runs(id,source_id,started_at,finished_at,status,fetched,created,updated,message) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.sourceId, run.startedAt, run.finishedAt, run.status, run.fetched || 0, run.created || 0, run.updated || 0, run.message || '');
  }

  recentRuns(limit = 30) {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) c FROM events').get().c;
    const upcoming = this.db.prepare('SELECT COUNT(*) c FROM events WHERE start_at >= ?').get(new Date().toISOString().slice(0, 10)).c;
    const bySchool = this.db.prepare('SELECT school, COUNT(*) c FROM events GROUP BY school ORDER BY c DESC').all();
    const byKind = this.db.prepare('SELECT kind, COUNT(*) c FROM events GROUP BY kind ORDER BY c DESC').all();
    return {total, upcoming, bySchool, byKind};
  }
}

function rowToEvent(r) {
  return {
    id: r.id, sourceId: r.source_id, school: r.school, city: r.city, kind: r.kind,
    title: r.title, company: r.company, startAt: r.start_at, endAt: r.end_at,
    venue: r.venue, address: r.address, industry: r.industry, companySize: r.company_size,
    positions: r.positions, requirements: r.requirements, applyMode: r.apply_mode, applyUrl: r.apply_url,
    sourceUrl: r.source_url, publishedAt: r.published_at, fetchedAt: r.fetched_at,
    confidence: r.confidence, verified: !!r.verified, rawText: r.raw_text, notes: r.notes
  };
}
