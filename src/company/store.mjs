// 公司档案：保存调研结果，并与招聘活动、投递记录按公司名关联。
let DatabaseSync;
try {
  ({DatabaseSync} = await import('node:sqlite'));
} catch {
  throw new Error('当前 Node 版本不支持内置 SQLite（node:sqlite）。请升级到 Node 23+。');
}
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, industry TEXT, size TEXT, city TEXT,
  website TEXT, summary TEXT, prospects TEXT, reputation TEXT, compensation TEXT,
  culture TEXT, sources_json TEXT, notes TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies(updated_at);
`;

const LIMITS = {name: 80, short: 60, long: 6000, url: 300, notes: 3000};

function clean(value, max, field, {multiline = false} = {}) {
  if (typeof value !== 'string') throw new Error(field + ' 必须是文字');
  const text = multiline ? value.replace(/\r\n/g, '\n').trim() : value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(field + ' 不能为空');
  if (text.length > max) throw new Error(field + ' 不能超过 ' + max + ' 个字');
  return text;
}
function optional(value, max, field, opts) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return clean(String(value), max, field, opts);
}

function normalize(input) {
  const name = clean(input.name || '', LIMITS.name, '公司名称');
  const sources = Array.isArray(input.sources) ? input.sources.slice(0, 20).map(s => ({
    title: optional(s?.title, 120, '来源标题'),
    url: optional(s?.url, LIMITS.url, '来源链接')
  })).filter(s => s.url) : [];
  return {
    name,
    industry: optional(input.industry, LIMITS.short, '行业'),
    size: optional(input.size, LIMITS.short, '规模'),
    city: optional(input.city, LIMITS.short, '城市'),
    website: optional(input.website, LIMITS.url, '官网'),
    summary: optional(input.summary, LIMITS.long, '公司介绍', {multiline: true}),
    prospects: optional(input.prospects, LIMITS.long, '发展前景', {multiline: true}),
    reputation: optional(input.reputation, LIMITS.long, '公司评价', {multiline: true}),
    compensation: optional(input.compensation, LIMITS.long, '综合待遇', {multiline: true}),
    culture: optional(input.culture, LIMITS.long, '企业文化', {multiline: true}),
    notes: optional(input.notes, LIMITS.notes, '备注', {multiline: true}),
    sources
  };
}

export class CompanyStore {
  constructor(file) {
    mkdirSync(dirname(file), {recursive: true});
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }
  static open(file) { return new CompanyStore(file); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  list() {
    return this.db.prepare('SELECT * FROM companies ORDER BY updated_at DESC').all().map(rowToCompany);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM companies WHERE id=?').get(id);
    return row ? rowToCompany(row) : null;
  }

  byName(name) {
    const row = this.db.prepare('SELECT * FROM companies WHERE name=?').get(String(name || '').trim());
    return row ? rowToCompany(row) : null;
  }

  save(input) {
    const data = normalize(input);
    const now = new Date().toISOString();
    let existing = input.id ? this.get(input.id) : this.byName(data.name);
    if (existing) {
      // 局部更新：没传的字段保留原值；显式传空字符串才清空。
      for (const key of ['industry', 'size', 'city', 'website', 'summary', 'prospects', 'reputation', 'compensation', 'culture', 'notes']) {
        if (input[key] === undefined) data[key] = existing[key] || '';
      }
      if (input.sources === undefined) data.sources = existing.sources || [];
      this.db.prepare(`UPDATE companies SET name=?,industry=?,size=?,city=?,website=?,summary=?,prospects=?,
        reputation=?,compensation=?,culture=?,sources_json=?,notes=?,updated_at=? WHERE id=?`)
        .run(data.name, data.industry, data.size, data.city, data.website, data.summary, data.prospects,
          data.reputation, data.compensation, data.culture, JSON.stringify(data.sources), data.notes, now, existing.id);
      return this.get(existing.id);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO companies(id,name,industry,size,city,website,summary,prospects,reputation,
      compensation,culture,sources_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, data.name, data.industry, data.size, data.city, data.website, data.summary, data.prospects,
        data.reputation, data.compensation, data.culture, JSON.stringify(data.sources), data.notes, now, now);
    return this.get(id);
  }

  delete(id) {
    this.db.prepare('DELETE FROM companies WHERE id=?').run(id);
  }

  stats() {
    return {companies: this.db.prepare('SELECT COUNT(*) c FROM companies').get().c};
  }
}

function rowToCompany(r) {
  let sources = [];
  try { sources = JSON.parse(r.sources_json || '[]'); } catch { sources = []; }
  return {
    id: r.id, name: r.name, industry: r.industry, size: r.size, city: r.city, website: r.website,
    summary: r.summary, prospects: r.prospects, reputation: r.reputation, compensation: r.compensation,
    culture: r.culture, sources: Array.isArray(sources) ? sources : [], notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
