// 公众号账号与文章记录：只存标题、链接、时间和解析出的活动草稿，不批量抓取。
let DatabaseSync;
try { ({DatabaseSync} = await import('node:sqlite')); }
catch { throw new Error('当前 Node 版本不支持内置 SQLite，请升级到 Node 23+。'); }
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SEED_ACCOUNTS} from './accounts.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wechat_accounts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, school TEXT, category TEXT,
  biz TEXT, home_url TEXT, note TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS wechat_articles(
  id TEXT PRIMARY KEY, account_id TEXT, title TEXT, url TEXT UNIQUE,
  published_at TEXT, summary TEXT, content TEXT, event_id TEXT, created_at TEXT,
  has_recruitment TEXT, analysis_summary TEXT, extracted_json TEXT,
  project_count INTEGER DEFAULT 0, analyzed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wechat_articles_account ON wechat_articles(account_id);
`;

export class WeChatStore {
  constructor(file) {
    mkdirSync(dirname(file), {recursive: true});
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrate();
    this.seed();
  }
  static open(file) { return new WeChatStore(file); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(wechat_articles)').all().map(r => r.name));
    for (const [name, ddl] of [
      ['has_recruitment', 'TEXT'], ['analysis_summary', 'TEXT'], ['extracted_json', 'TEXT'],
      ['project_count', 'INTEGER DEFAULT 0'], ['analyzed_at', 'TEXT']
    ]) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE wechat_articles ADD COLUMN ${name} ${ddl}`);
    }
  }

  seed() {
    const count = this.db.prepare('SELECT COUNT(*) c FROM wechat_accounts').get().c;
    if (count) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO wechat_accounts(id,name,school,category,biz,home_url,note,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const a of SEED_ACCOUNTS) stmt.run(randomUUID(), a.name, a.school || '', a.category || '', a.biz || '', a.home_url || '', a.note || '', now, now);
  }

  listAccounts() {
    return this.db.prepare(`SELECT a.*, COUNT(r.id) AS articles FROM wechat_accounts a
      LEFT JOIN wechat_articles r ON r.account_id = a.id GROUP BY a.id ORDER BY a.category, a.school`).all().map(r => ({
      id: r.id, name: r.name, school: r.school, category: r.category, biz: r.biz,
      homeUrl: r.home_url, note: r.note, articles: Number(r.articles) || 0
    }));
  }

  addAccount(input) {
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('公众号名称不能为空');
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM wechat_accounts WHERE name=?').get(name);
    if (existing) return this.getAccount(existing.id);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO wechat_accounts(id,name,school,category,biz,home_url,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, name, String(input.school || '').slice(0, 60), String(input.category || '').slice(0, 40), String(input.biz || '').slice(0, 80), String(input.homeUrl || '').slice(0, 300), String(input.note || '').slice(0, 500), now, now);
    return this.getAccount(id);
  }

  getAccount(id) {
    const r = this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(id);
    return r ? {id: r.id, name: r.name, school: r.school, category: r.category, biz: r.biz, homeUrl: r.home_url, note: r.note} : null;
  }

  accountByBiz(biz) {
    const r = this.db.prepare('SELECT * FROM wechat_accounts WHERE biz=?').get(biz);
    return r ? {id: r.id, name: r.name, school: r.school, category: r.category, biz: r.biz} : null;
  }

  saveArticle({accountId, title, url, publishedAt = '', summary = '', content = '', eventId = '', hasRecruitment = '', analysisSummary = '', extractedJson = '', projectCount = 0, analyzedAt = ''}) {
    const name = String(title || '').trim().slice(0, 200);
    const link = String(url || '').trim().slice(0, 500);
    if (!name || !/^https?:\/\//.test(link)) throw new Error('文章标题和链接必填');
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM wechat_articles WHERE url=?').get(link);
    const id = existing?.id || randomUUID();
    if (existing) {
      this.db.prepare(`UPDATE wechat_articles SET account_id=?,title=?,published_at=?,summary=?,content=?,
        event_id=COALESCE(NULLIF(?,''),event_id),has_recruitment=?,analysis_summary=?,extracted_json=?,project_count=?,analyzed_at=? WHERE id=?`)
        .run(accountId || '', name, publishedAt, summary, content, eventId,
          String(hasRecruitment || '').slice(0, 20), String(analysisSummary || '').slice(0, 2000),
          String(extractedJson || '').slice(0, 20000), Number(projectCount) || 0, String(analyzedAt || '').slice(0, 40), id);
    } else {
      this.db.prepare(`INSERT INTO wechat_articles(id,account_id,title,url,published_at,summary,content,event_id,created_at,has_recruitment,analysis_summary,extracted_json,project_count,analyzed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, accountId || '', name, link, publishedAt, summary, content, eventId, now,
          String(hasRecruitment || '').slice(0, 20), String(analysisSummary || '').slice(0, 2000),
          String(extractedJson || '').slice(0, 20000), Number(projectCount) || 0, String(analyzedAt || '').slice(0, 40));
    }
    return this.getArticle(id);
  }

  saveAnalysis(id, analysis) {
    this.db.prepare(`UPDATE wechat_articles SET has_recruitment=?,analysis_summary=?,extracted_json=?,project_count=?,analyzed_at=? WHERE id=?`)
      .run(String(analysis.hasRecruitment || 'uncertain').slice(0, 20), String(analysis.summary || '').slice(0, 2000),
        JSON.stringify(analysis).slice(0, 20000), (analysis.projects || []).length, new Date().toISOString(), id);
    return this.getArticle(id);
  }

  getArticle(id) {
    const r = this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(id);
    return r ? rowToArticle(r) : null;
  }

  listArticles({accountId = '', limit = 100} = {}) {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM wechat_articles WHERE account_id=? ORDER BY created_at DESC LIMIT ?').all(accountId, limit)
      : this.db.prepare('SELECT * FROM wechat_articles ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(rowToArticle);
  }

  deleteArticle(id) { this.db.prepare('DELETE FROM wechat_articles WHERE id=?').run(id); }

  stats() {
    return {
      accounts: this.db.prepare('SELECT COUNT(*) c FROM wechat_accounts').get().c,
      articles: this.db.prepare('SELECT COUNT(*) c FROM wechat_articles').get().c
    };
  }
}

function rowToArticle(r) {
  return {
    id: r.id, accountId: r.account_id, title: r.title, url: r.url,
    publishedAt: r.published_at, summary: r.summary, content: r.content,
    eventId: r.event_id, createdAt: r.created_at,
    hasRecruitment: r.has_recruitment || '', analysisSummary: r.analysis_summary || '',
    extractedJson: r.extracted_json || '', projectCount: Number(r.project_count) || 0,
    analyzedAt: r.analyzed_at || ''
  };
}
