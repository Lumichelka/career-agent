// 公众号账号与文章记录：只存标题、链接、时间和解析出的活动草稿，不批量抓取。
// 存储层负责三件容易出错的事：链接归一化去重、文章自动归属、清理演示数据。
let DatabaseSync;
try { ({DatabaseSync} = await import('node:sqlite')); }
catch { throw new Error('当前 Node 版本不支持内置 SQLite，请升级到 Node 23+。'); }
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {SEED_ACCOUNTS} from './accounts.mjs';
import {accountNameKey, bizOf, canonicalArticleUrl, contentFingerprint, isDemoUrl, normalizeAccountName} from './identity.mjs';
import {matchAccount} from './attribute.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wechat_accounts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, school TEXT, category TEXT,
  biz TEXT, home_url TEXT, note TEXT, created_at TEXT, updated_at TEXT,
  alias_biz TEXT, alias_names TEXT, feed_url TEXT,
  last_sync_at TEXT, last_sync_status TEXT, last_sync_error TEXT
);
CREATE TABLE IF NOT EXISTS wechat_articles(
  id TEXT PRIMARY KEY, account_id TEXT, title TEXT, url TEXT UNIQUE,
  published_at TEXT, summary TEXT, content TEXT, event_id TEXT, created_at TEXT,
  has_recruitment TEXT, analysis_summary TEXT, extracted_json TEXT,
  project_count INTEGER DEFAULT 0, analyzed_at TEXT,
  nickname TEXT, biz TEXT, content_hash TEXT, dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_wechat_articles_account ON wechat_articles(account_id);
`;

const ACCOUNT_MIGRATIONS = [
  ['alias_biz', 'TEXT'], ['alias_names', 'TEXT'], ['feed_url', 'TEXT'],
  ['last_sync_at', 'TEXT'], ['last_sync_status', 'TEXT'], ['last_sync_error', 'TEXT']
];
const ARTICLE_MIGRATIONS = [
  ['has_recruitment', 'TEXT'], ['analysis_summary', 'TEXT'], ['extracted_json', 'TEXT'],
  ['project_count', 'INTEGER DEFAULT 0'], ['analyzed_at', 'TEXT'],
  ['nickname', 'TEXT'], ['biz', 'TEXT'], ['content_hash', 'TEXT'], ['dedupe_key', 'TEXT']
];

function parseList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr.map(v => String(v).trim()).filter(Boolean); } catch { /* 旧数据可能是逗号分隔 */ }
  }
  return text.split(/[,，;；\n]/).map(v => v.trim()).filter(Boolean);
}

function listJson(value) {
  return JSON.stringify([...new Set(parseList(value))]);
}

function isFallbackAccount(account) {
  const key = accountNameKey(account?.name || '');
  return !key || key.includes('未归类') || key.includes('待归类') || key === '未知公众号';
}

function rowToAccount(r) {
  return {
    id: r.id, name: r.name, school: r.school || '', category: r.category || '',
    biz: r.biz || '', homeUrl: r.home_url || '', note: r.note || '',
    aliasBiz: parseList(r.alias_biz), aliasNames: parseList(r.alias_names),
    feedUrl: r.feed_url || '', lastSyncAt: r.last_sync_at || '',
    lastSyncStatus: r.last_sync_status || '', lastSyncError: r.last_sync_error || ''
  };
}

function rowToArticle(r) {
  return {
    id: r.id, accountId: r.account_id, title: r.title, url: r.url,
    publishedAt: r.published_at, summary: r.summary, content: r.content,
    eventId: r.event_id, createdAt: r.created_at,
    hasRecruitment: r.has_recruitment || '', analysisSummary: r.analysis_summary || '',
    extractedJson: r.extracted_json || '', projectCount: Number(r.project_count) || 0,
    analyzedAt: r.analyzed_at || '', nickname: r.nickname || '', biz: r.biz || '',
    contentHash: r.content_hash || '', dedupeKey: r.dedupe_key || ''
  };
}

export class WeChatStore {
  constructor(file, {readOnly = false} = {}) {
    this.file = file;
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dirname(file), {recursive: true});
    this.db = new DatabaseSync(file, readOnly ? {readOnly: true} : {});
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (readOnly) return;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
    this.seed();
    this.upgradeData();
  }
  static open(file, options) { return new WeChatStore(file, options); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  migrate() {
    const acols = new Set(this.db.prepare('PRAGMA table_info(wechat_accounts)').all().map(r => r.name));
    for (const [name, ddl] of ACCOUNT_MIGRATIONS) {
      if (!acols.has(name)) this.db.exec(`ALTER TABLE wechat_accounts ADD COLUMN ${name} ${ddl}`);
    }
    const cols = new Set(this.db.prepare('PRAGMA table_info(wechat_articles)').all().map(r => r.name));
    for (const [name, ddl] of ARTICLE_MIGRATIONS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE wechat_articles ADD COLUMN ${name} ${ddl}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_wechat_articles_dedupe ON wechat_articles(dedupe_key)');
  }

  // 种子账号只补齐公开信息；订阅地址/最近同步时间不会被种子覆盖。
  seed() {
    const now = new Date().toISOString();
    for (const a of SEED_ACCOUNTS) {
      const names = [a.name, ...(a.legacyNames || [])];
      const bizList = [a.biz, ...(a.legacyBiz || [])].filter(Boolean);
      const placeholders = names.map(() => '?').join(',');
      const bizPlaceholders = bizList.map(() => '?').join(',');
      const sql = 'SELECT * FROM wechat_accounts WHERE name IN (' + placeholders + ')' + (bizList.length ? ' OR biz IN (' + bizPlaceholders + ')' : '');
      let existing = this.db.prepare(sql).get(...names, ...bizList);
      if (!existing) {
        for (const row of this.db.prepare('SELECT * FROM wechat_accounts').all()) {
          const keys = new Set([row.name, ...parseList(row.alias_names)].map(accountNameKey));
          if (names.some(n => keys.has(accountNameKey(n)))) { existing = row; break; }
        }
      }
      if (existing) {
        // 旧库可能同时存在“西财就业”（别名行）和“西财校招”（canonical 行）；
        // 直接把旧行改名会撞 name UNIQUE，先合并到 canonical 行再更新种子字段。
        const conflict = this.db.prepare('SELECT * FROM wechat_accounts WHERE name=? AND id<>?').get(a.name, existing.id);
        if (conflict) existing = this.mergeAccountRows(conflict.id, existing.id) || existing;
        const keepAliasBiz = [existing.biz, ...parseList(existing.alias_biz)].filter(v => v && v !== a.biz);
        const keepAliasNames = [existing.name, ...parseList(existing.alias_names)].filter(v => v && v !== a.name);
        this.db.prepare(`UPDATE wechat_accounts SET name=?,school=?,category=?,biz=?,alias_biz=?,alias_names=?,note=?,updated_at=? WHERE id=?`)
          .run(a.name, a.school || existing.school || '', a.category || existing.category || '', a.biz || existing.biz || '',
            listJson([...keepAliasBiz, ...(a.legacyBiz || [])]), listJson([...keepAliasNames, ...(a.legacyNames || [])]),
            a.note || existing.note || '', now, existing.id);
      } else {
        this.db.prepare(`INSERT INTO wechat_accounts(id,name,school,category,biz,home_url,note,created_at,updated_at,alias_biz,alias_names,feed_url)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), a.name, a.school || '', a.category || '', a.biz || '', a.home_url || '', a.note || '', now, now,
          listJson(a.legacyBiz || []), listJson(a.legacyNames || []), '');
      }
    }
  }

  // 账号去重：把 drop 行并入 keep 行（文章改挂、别名/订阅/同步状态取并集），再删 drop。
  mergeAccountRows(keepId, dropId) {
    if (!keepId || !dropId || keepId === dropId) return this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(keepId) || null;
    const keep = this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(keepId);
    const drop = this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(dropId);
    if (!keep || !drop) return keep || drop || null;
    this.db.prepare('UPDATE wechat_articles SET account_id=? WHERE account_id=?').run(keepId, dropId);
    const keepNameKey = accountNameKey(keep.name);
    const names = [...new Set([
      ...parseList(keep.alias_names), drop.name, ...parseList(drop.alias_names)
    ].filter(name => name && accountNameKey(name) !== keepNameKey))];
    const biz = [...new Set([
      ...parseList(keep.alias_biz), keep.biz, drop.biz, ...parseList(drop.alias_biz)
    ].filter(value => value && value !== keep.biz))];
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE wechat_accounts SET school=?,category=?,biz=?,home_url=?,note=?,alias_biz=?,alias_names=?,
      feed_url=?,last_sync_at=?,last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=?`)
      .run(keep.school || drop.school || '', keep.category || drop.category || '', keep.biz || drop.biz || '',
        keep.home_url || drop.home_url || '', keep.note || drop.note || '', listJson(biz), listJson(names),
        keep.feed_url || drop.feed_url || '', keep.last_sync_at || drop.last_sync_at || '',
        keep.last_sync_status || drop.last_sync_status || '', keep.last_sync_error || drop.last_sync_error || '', now, keepId);
    this.db.prepare('DELETE FROM wechat_accounts WHERE id=?').run(dropId);
    return this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(keepId);
  }

  // 旧库升级：链接归一化、合并重复文章、清 example.com、把“未归类”文章重新归属到已知账号。
  upgradeData() {
    try {
      this.db.exec('BEGIN');
      this.canonicalizeArticles();
      this.purgeDemoData();
      this.backfillAttribution();
      this.db.exec('COMMIT');
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      // 升级失败不阻塞使用；下次打开会重试。
    }
  }

  canonicalizeArticles() {
    for (const row of this.db.prepare('SELECT * FROM wechat_articles').all()) {
      const canonical = canonicalArticleUrl(row.url) || String(row.url || '');
      if (canonical === row.url) continue;
      const conflict = this.db.prepare('SELECT * FROM wechat_articles WHERE url=? AND id<>?').get(canonical, row.id);
      if (conflict) this.mergeArticleRows(conflict.id, row.id);
      else this.db.prepare('UPDATE wechat_articles SET url=? WHERE id=?').run(canonical, row.id);
    }
  }

  mergeArticleRows(keepId, dropId) {
    const keep = this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(keepId);
    const drop = this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(dropId);
    if (!keep || !drop) return keep;
    const longer = String(drop.content || '').length > String(keep.content || '').length ? drop : keep;
    const analyzed = (drop.has_recruitment || drop.analyzed_at) && !keep.analyzed_at ? drop : keep;
    this.db.prepare(`UPDATE wechat_articles SET account_id=?,title=?,published_at=?,summary=?,content=?,event_id=?,has_recruitment=?,analysis_summary=?,extracted_json=?,project_count=?,analyzed_at=?,nickname=?,biz=?,content_hash=?,dedupe_key=? WHERE id=?`)
      .run(keep.account_id || drop.account_id || '', keep.title || drop.title || '', keep.published_at || drop.published_at || '',
        keep.summary || drop.summary || '', longer.content || '', keep.event_id || drop.event_id || '',
        analyzed.has_recruitment || '', analyzed.analysis_summary || '', analyzed.extracted_json || '',
        Math.max(Number(keep.project_count) || 0, Number(drop.project_count) || 0), analyzed.analyzed_at || '',
        keep.nickname || drop.nickname || '', keep.biz || drop.biz || '', longer.content_hash || '', keep.dedupe_key || drop.dedupe_key || '', keepId);
    this.db.prepare('DELETE FROM wechat_articles WHERE id=?').run(dropId);
    return this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(keepId);
  }

  purgeDemoData() {
    const rows = this.db.prepare('SELECT id,url,event_id FROM wechat_articles').all().filter(r => isDemoUrl(r.url));
    for (const row of rows) this.db.prepare('DELETE FROM wechat_articles WHERE id=?').run(row.id);
    return rows.length;
  }

  // 只对“未归类/没有账号”的文章做回填；已有明确账号的文章不因正文里提到别的学校而改挂。
  backfillAttribution() {
    const accounts = this.matchingAccounts();
    const usable = accounts.filter(a => !isFallbackAccount(a));
    for (const row of this.db.prepare('SELECT * FROM wechat_articles').all()) {
      const current = accounts.find(a => a.id === row.account_id);
      const biz = row.biz || bizOf(row.url);
      if (!row.biz && biz) this.db.prepare('UPDATE wechat_articles SET biz=? WHERE id=?').run(biz, row.id);
      if (current && !isFallbackAccount(current)) {
        if (!current.biz && biz) this.db.prepare('UPDATE wechat_accounts SET biz=?,updated_at=? WHERE id=?').run(biz, new Date().toISOString(), current.id);
        continue;
      }
      const hit = matchAccount(usable, {biz, nickname: row.nickname || '', title: row.title || '', text: row.content || ''});
      if (!hit) continue;
      this.db.prepare('UPDATE wechat_articles SET account_id=? WHERE id=?').run(hit.account.id, row.id);
      if (!hit.account.biz && biz) this.db.prepare('UPDATE wechat_accounts SET biz=?,updated_at=? WHERE id=?').run(biz, new Date().toISOString(), hit.account.id);
    }
    this.removeEmptyFallbackAccounts();
  }

  removeEmptyFallbackAccounts() {
    const fallbacks = this.db.prepare('SELECT id,name FROM wechat_accounts').all().filter(a => isFallbackAccount(a));
    for (const account of fallbacks) {
      const used = this.db.prepare('SELECT COUNT(*) c FROM wechat_articles WHERE account_id=?').get(account.id).c;
      if (!used) this.db.prepare('DELETE FROM wechat_accounts WHERE id=?').run(account.id);
    }
  }

  matchingAccounts() { return this.db.prepare('SELECT * FROM wechat_accounts').all().map(rowToAccount); }

  listAccounts() {
    return this.db.prepare(`SELECT a.*, COUNT(r.id) AS articles,
        MAX(r.analyzed_at) AS last_analysis,
        MAX(COALESCE(NULLIF(r.published_at,''), r.created_at)) AS last_article_at,
        SUM(CASE WHEN r.has_recruitment='yes' THEN 1 ELSE 0 END) AS recruitment_articles
      FROM wechat_accounts a
      LEFT JOIN wechat_articles r ON r.account_id = a.id
      GROUP BY a.id ORDER BY a.category, a.school, a.name`).all().map(r => ({
      ...rowToAccount(r),
      articles: Number(r.articles) || 0,
      lastAnalysis: r.last_analysis || '',
      lastArticleAt: r.last_article_at || '',
      recruitmentArticles: Number(r.recruitment_articles) || 0,
      subscribed: !!(r.feed_url || '')
    }));
  }

  addAccount(input = {}) {
    const name = normalizeAccountName(input.name);
    if (!name) throw new Error('公众号名称不能为空');
    const biz = String(input.biz || '').trim().slice(0, 200);
    const key = accountNameKey(name);
    let existing = null;
    for (const row of this.db.prepare('SELECT * FROM wechat_accounts').all()) {
      const names = new Set([row.name, ...parseList(row.alias_names)].map(accountNameKey));
      const bizList = new Set([row.biz, ...parseList(row.alias_biz)].filter(Boolean));
      if (names.has(key) || (biz && bizList.has(biz))) { existing = row; break; }
    }
    if (existing && isFallbackAccount(existing) && !isFallbackAccount({name}) && !this.db.prepare('SELECT id FROM wechat_accounts WHERE name=? AND id<>?').get(name, existing.id)) {
      this.db.prepare('UPDATE wechat_accounts SET name=? WHERE id=?').run(name, existing.id);
      existing = this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(existing.id);
    }
    const now = new Date().toISOString();
    if (existing) {
      const next = {
        school: String(input.school || '').slice(0, 60) || existing.school || '',
        category: String(input.category || '').slice(0, 40) || existing.category || '',
        biz: biz || existing.biz || '',
        homeUrl: String(input.homeUrl || '').slice(0, 300) || existing.home_url || '',
        note: String(input.note || '').slice(0, 500) || existing.note || '',
        feedUrl: String(input.feedUrl || '').slice(0, 500) || existing.feed_url || '',
        aliasBiz: listJson([...parseList(existing.alias_biz), ...(input.aliasBiz || input.legacyBiz || []), ...parseList(input.aliases?.biz)]),
        aliasNames: listJson([...parseList(existing.alias_names), ...(input.aliasNames || input.legacyNames || []), ...parseList(input.aliases?.names)])
      };
      this.db.prepare(`UPDATE wechat_accounts SET school=?,category=?,biz=?,home_url=?,note=?,feed_url=?,alias_biz=?,alias_names=?,updated_at=? WHERE id=?`)
        .run(next.school, next.category, next.biz, next.homeUrl, next.note, next.feedUrl, next.aliasBiz, next.aliasNames, now, existing.id);
      return this.getAccount(existing.id);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO wechat_accounts(id,name,school,category,biz,home_url,note,created_at,updated_at,alias_biz,alias_names,feed_url)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, String(input.school || '').slice(0, 60), String(input.category || '').slice(0, 40),
      biz, String(input.homeUrl || '').slice(0, 300), String(input.note || '').slice(0, 500), now, now,
      listJson([...(input.aliasBiz || input.legacyBiz || []), ...parseList(input.aliases?.biz)]),
      listJson([...(input.aliasNames || input.legacyNames || []), ...parseList(input.aliases?.names)]),
      String(input.feedUrl || '').slice(0, 500));
    return this.getAccount(id);
  }

  getAccount(id) {
    const r = this.db.prepare('SELECT * FROM wechat_accounts WHERE id=?').get(id);
    return r ? {...rowToAccount(r), subscribed: !!r.feed_url, articles: Number(this.db.prepare('SELECT COUNT(*) c FROM wechat_articles WHERE account_id=?').get(id).c) || 0} : null;
  }

  accountByBiz(biz) {
    if (!biz) return null;
    return this.matchingAccounts().find(a => [a.biz, ...a.aliasBiz].filter(Boolean).includes(biz)) || null;
  }

  setSubscription(id, feedUrl) {
    const link = String(feedUrl || '').trim().slice(0, 500);
    if (link && !/^https?:\/\//i.test(link)) throw new Error('订阅地址需以 http:// 或 https:// 开头');
    this.db.prepare('UPDATE wechat_accounts SET feed_url=?,updated_at=? WHERE id=?').run(link, new Date().toISOString(), id);
    return this.getAccount(id);
  }

  markSync(id, {status = 'ok', error = '', count = 0} = {}) {
    this.db.prepare('UPDATE wechat_accounts SET last_sync_at=?,last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), String(status || '').slice(0, 20), String(error || '').slice(0, 300), new Date().toISOString(), id);
    return this.getAccount(id);
  }

  listSubscribed() {
    return this.matchingAccounts().filter(a => a.feedUrl);
  }

  resolveAccount({accountId = '', biz = '', nickname = '', title = '', text = '', school = ''} = {}) {
    const accounts = this.matchingAccounts();
    const current = accountId ? accounts.find(a => a.id === accountId) : null;
    const usable = accounts.filter(a => !isFallbackAccount(a));
    const hit = matchAccount(usable, {biz, nickname, title, text});
    if (hit) {
      if (!current || isFallbackAccount(current)) return hit.account;
      if (!current.biz && hit.reason === 'biz') return hit.account;
      return current;
    }
    if (current && !isFallbackAccount(current)) return current;
    if (nickname) return this.addAccount({name: nickname, school, biz, note: '从文章昵称自动创建'});
    return current || null;
  }

  saveArticle(input = {}) {
    const title = String(input.title || '').trim().slice(0, 200);
    const link = canonicalArticleUrl(input.url);
    if (!title || !link) throw new Error('文章标题和链接必填');
    const inputAccount = input.accountId ? this.getAccount(input.accountId) : null;
    const inputWasFallback = !!inputAccount && isFallbackAccount(inputAccount);
    const content = String(input.content || '').slice(0, 20000);
    const summary = String(input.summary || '').slice(0, 300);
    const publishedAt = String(input.publishedAt || '').slice(0, 40);
    const nickname = String(input.nickname || '').slice(0, 80);
    const biz = String(input.biz || bizOf(link) || '').slice(0, 200);
    const account = this.resolveAccount({accountId: input.accountId, biz, nickname, title, text: content, school: input.school});
    const accountId = account?.id || input.accountId || '';
    const contentHash = contentFingerprint(content);
    const titleKey = title.replace(/\s+/g, '').slice(0, 80);
    const dedupeKey = accountId && titleKey && (publishedAt || contentHash)
      ? createHash('sha1').update([accountId, titleKey, publishedAt || '', contentHash || ''].join('|')).digest('hex').slice(0, 32)
      : '';
    const now = new Date().toISOString();

    let existing = this.db.prepare('SELECT * FROM wechat_articles WHERE url=?').get(link);
    if (!existing && dedupeKey) existing = this.db.prepare('SELECT * FROM wechat_articles WHERE dedupe_key=? AND account_id=? LIMIT 1').get(dedupeKey, accountId);
    if (!existing && contentHash) existing = this.db.prepare('SELECT * FROM wechat_articles WHERE content_hash=? AND account_id=? LIMIT 1').get(contentHash, accountId);
    if (existing && existing.url !== link) {
      const conflict = this.db.prepare('SELECT * FROM wechat_articles WHERE url=? AND id<>?').get(link, existing.id);
      if (conflict) existing = this.mergeArticleRows(conflict.id, existing.id);
      else {
        this.db.prepare('UPDATE wechat_articles SET url=? WHERE id=?').run(link, existing.id);
        existing = this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(existing.id);
      }
    }

    if (existing) {
      const merged = {
        accountId: accountId || existing.account_id || '',
        title: title || existing.title,
        url: link,
        publishedAt: publishedAt || existing.published_at || '',
        summary: content.length >= String(existing.content || '').length ? (summary || existing.summary || '') : (existing.summary || summary),
        content: content.length >= String(existing.content || '').length ? content : (existing.content || content),
        eventId: existing.event_id || '',
        hasRecruitment: String(input.hasRecruitment || existing.has_recruitment || ''),
        analysisSummary: String(input.analysisSummary || existing.analysis_summary || ''),
        extractedJson: String(input.extractedJson || existing.extracted_json || ''),
        projectCount: Math.max(Number(existing.project_count) || 0, Number(input.projectCount) || 0),
        analyzedAt: String(input.analyzedAt || existing.analyzed_at || ''),
        nickname: nickname || existing.nickname || '',
        biz: biz || existing.biz || '',
        contentHash: contentHash || existing.content_hash || '',
        dedupeKey: dedupeKey || existing.dedupe_key || ''
      };
      this.db.prepare(`UPDATE wechat_articles SET account_id=?,title=?,url=?,published_at=?,summary=?,content=?,event_id=?,
        has_recruitment=?,analysis_summary=?,extracted_json=?,project_count=?,analyzed_at=?,nickname=?,biz=?,content_hash=?,dedupe_key=? WHERE id=?`)
        .run(merged.accountId, merged.title, merged.url, merged.publishedAt, merged.summary, merged.content, merged.eventId,
          merged.hasRecruitment.slice(0, 20), merged.analysisSummary.slice(0, 2000), merged.extractedJson.slice(0, 20000),
          merged.projectCount, merged.analyzedAt.slice(0, 40), merged.nickname, merged.biz, merged.contentHash, merged.dedupeKey, existing.id);
      this.fillAccountBiz(merged.accountId, merged.biz);
      if (inputWasFallback && merged.accountId && merged.accountId !== input.accountId) this.removeEmptyFallbackAccounts();
      return this.getArticle(existing.id);
    }

    const id = randomUUID();
    this.db.prepare(`INSERT INTO wechat_articles(id,account_id,title,url,published_at,summary,content,event_id,created_at,has_recruitment,analysis_summary,extracted_json,project_count,analyzed_at,nickname,biz,content_hash,dedupe_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, title, link, publishedAt, summary, content, '',
      now, String(input.hasRecruitment || '').slice(0, 20), String(input.analysisSummary || '').slice(0, 2000),
      String(input.extractedJson || '').slice(0, 20000), Number(input.projectCount) || 0, String(input.analyzedAt || '').slice(0, 40),
      nickname, biz, contentHash, dedupeKey);
    this.fillAccountBiz(accountId, biz);
    if (inputWasFallback && accountId && accountId !== input.accountId) this.removeEmptyFallbackAccounts();
    return this.getArticle(id);
  }

  fillAccountBiz(accountId, biz) {
    if (!accountId || !biz) return;
    const account = this.getAccount(accountId);
    if (account && !account.biz) this.db.prepare('UPDATE wechat_accounts SET biz=?,updated_at=? WHERE id=?').run(biz, new Date().toISOString(), accountId);
  }

  saveAnalysis(id, analysis) {
    this.db.prepare(`UPDATE wechat_articles SET has_recruitment=?,analysis_summary=?,extracted_json=?,project_count=?,analyzed_at=? WHERE id=?`)
      .run(String(analysis.hasRecruitment || 'uncertain').slice(0, 20), String(analysis.summary || '').slice(0, 2000),
        JSON.stringify(analysis).slice(0, 20000), (analysis.projects || []).length, new Date().toISOString(), id);
    return this.getArticle(id);
  }

  getArticle(id) {
    if (!id) return null;
    const r = this.db.prepare('SELECT * FROM wechat_articles WHERE id=?').get(id);
    return r ? rowToArticle(r) : null;
  }

  findByUrl(url) {
    const link = canonicalArticleUrl(url);
    if (!link) return null;
    const row = this.db.prepare('SELECT id FROM wechat_articles WHERE url=?').get(link);
    return row ? this.getArticle(row.id) : null;
  }

  hasArticle(url) { return !!this.findByUrl(url); }

  reassignArticle(id, accountId) {
    this.db.prepare('UPDATE wechat_articles SET account_id=? WHERE id=?').run(accountId, id);
    return this.getArticle(id);
  }

  linkEvent(id, eventId) {
    this.db.prepare('UPDATE wechat_articles SET event_id=? WHERE id=?').run(String(eventId || ''), id);
    return this.getArticle(id);
  }

  listArticles({accountId = '', limit = 100} = {}) {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM wechat_articles WHERE account_id=? ORDER BY COALESCE(NULLIF(published_at,\'\'), created_at) DESC LIMIT ?').all(accountId, limit)
      : this.db.prepare('SELECT * FROM wechat_articles ORDER BY COALESCE(NULLIF(published_at,\'\'), created_at) DESC LIMIT ?').all(limit);
    return rows.map(rowToArticle);
  }

  // 只读查询：按公众号名称/别名、学校、关键词与是否含招聘筛选；count 是命中总数，不受 limit 截断。
  searchArticles({account = '', school = '', q = '', hasRecruitment = '', limit = 20} = {}) {
    const like = value => '%' + String(value).replace(/[\\%_]/g, m => '\\' + m) + '%';
    const where = [], args = [];
    const accountText = String(account || '').trim();
    if (accountText) {
      where.push("(a.name LIKE ? ESCAPE '\\' OR a.alias_names LIKE ? ESCAPE '\\')");
      args.push(like(accountText), like(accountText));
    }
    const schoolText = String(school || '').trim();
    if (schoolText) { where.push("a.school LIKE ? ESCAPE '\\'"); args.push(like(schoolText)); }
    const keyword = String(q || '').trim();
    if (keyword) {
      where.push("(r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\' OR r.analysis_summary LIKE ? ESCAPE '\\')");
      args.push(like(keyword), like(keyword), like(keyword));
    }
    const recruitment = String(hasRecruitment || '').trim();
    if (recruitment) { where.push('r.has_recruitment = ?'); args.push(recruitment); }
    const cap = Math.floor(Math.min(50, Math.max(1, Number(limit) || 20)));
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = Number(this.db.prepare('SELECT COUNT(*) c FROM wechat_articles r LEFT JOIN wechat_accounts a ON a.id=r.account_id' + filter).get(...args).c) || 0;
    const rows = this.db.prepare('SELECT r.*, a.name AS account_name, a.school AS account_school FROM wechat_articles r LEFT JOIN wechat_accounts a ON a.id=r.account_id' + filter + " ORDER BY COALESCE(NULLIF(r.published_at,''), r.created_at) DESC LIMIT ?").all(...args, cap);
    return {total, rows: rows.map(r => ({...rowToArticle(r), accountName: r.account_name || '', accountSchool: r.account_school || ''}))};
  }

  deleteArticle(id) { this.db.prepare('DELETE FROM wechat_articles WHERE id=?').run(id); }

  stats() {
    const accounts = Number(this.db.prepare('SELECT COUNT(*) c FROM wechat_accounts').get().c) || 0;
    const articles = Number(this.db.prepare('SELECT COUNT(*) c FROM wechat_articles').get().c) || 0;
    const demoArticles = this.db.prepare('SELECT url FROM wechat_articles').all().filter(r => isDemoUrl(r.url)).length;
    const fallbackIds = new Set(this.db.prepare('SELECT id,name FROM wechat_accounts').all().filter(a => isFallbackAccount(a)).map(a => a.id));
    const unattributed = this.db.prepare('SELECT account_id FROM wechat_articles').all().filter(r => !r.account_id || fallbackIds.has(r.account_id)).length;
    const subscribed = Number(this.db.prepare("SELECT COUNT(*) c FROM wechat_accounts WHERE COALESCE(feed_url,'')<>''").get().c) || 0;
    return {accounts, articles, demoArticles, unattributed, subscribed};
  }

  // 给“账号发现/订阅”和 API 用：把一篇文章挂到账号，并补上 biz 线索。
  applyArticleAccount(articleId, accountId) {
    this.reassignArticle(articleId, accountId);
    const article = this.getArticle(articleId);
    if (article?.biz) this.fillAccountBiz(accountId, article.biz);
    return this.getArticle(articleId);
  }
}
