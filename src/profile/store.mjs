// 长期画像库：每用户一个 profile.db，业务表 profile_facts；审计四张表由写网关在同库建。
// 画像条目只在用户确认后由写网关写入；这里只负责建表、校验与整行读/写。
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {WriteError} from '../writes/gateway.mjs';

export const PROFILE_FACT_LIMITS = {facts: 50, keyLength: 40, valueLength: 500, sourceLength: 80};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_facts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_facts_key ON profile_facts(user_id, key);
`;

export function profileDbPath(dir) {
  return join(String(dir || ''), 'profile.db');
}

// 只建业务表，不建审计表：没有自动写入时不留审计痕迹（审计表在网关构造时创建）。
export function openProfileDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function validateProfileFacts(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return 'facts 至少需要一条画像条目。';
  if (facts.length > PROFILE_FACT_LIMITS.facts) return '一次最多写入 ' + PROFILE_FACT_LIMITS.facts + ' 条画像。';
  const seen = new Set();
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i];
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return '第 ' + (i + 1) + ' 条画像格式不正确。';
    const key = text(fact.key, PROFILE_FACT_LIMITS.keyLength + 1);
    const value = text(fact.value, PROFILE_FACT_LIMITS.valueLength + 1);
    if (!key) return '第 ' + (i + 1) + ' 条画像缺少 key。';
    if (key.length > PROFILE_FACT_LIMITS.keyLength) return '第 ' + (i + 1) + ' 条画像的 key 不能超过 ' + PROFILE_FACT_LIMITS.keyLength + ' 个字。';
    if (!value) return '第 ' + (i + 1) + ' 条画像缺少 value。';
    if (value.length > PROFILE_FACT_LIMITS.valueLength) return '第 ' + (i + 1) + ' 条画像的 value 不能超过 ' + PROFILE_FACT_LIMITS.valueLength + ' 个字。';
    if (fact.source !== undefined && typeof fact.source !== 'string') return '第 ' + (i + 1) + ' 条画像的 source 必须是文字。';
    if (seen.has(key)) return '同一次写入里画像要点「' + key + '」重复；合并成一条再写。';
    seen.add(key);
  }
  return null;
}

export function normalizeProfileFacts(facts = []) {
  return facts.map(fact => ({
    key: text(fact.key, PROFILE_FACT_LIMITS.keyLength),
    value: text(fact.value, PROFILE_FACT_LIMITS.valueLength),
    source: text(fact.source, PROFILE_FACT_LIMITS.sourceLength)
  }));
}

function projectRow(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, key: row.key, value: row.value, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export function listProfileFacts(db, userId) {
  return db.prepare('SELECT * FROM profile_facts WHERE user_id=? ORDER BY key ASC').all(String(userId)).map(projectRow);
}

// 业务写入：按 (用户, key) 新增或更新；每条返回一条整行变更，交给写网关逐行审计。
export function writeProfileFacts({db, userId, facts, now = () => new Date().toISOString()}) {
  const at = now();
  const changes = [];
  const find = db.prepare('SELECT * FROM profile_facts WHERE user_id=? AND key=?');
  const insert = db.prepare('INSERT INTO profile_facts(id,user_id,key,value,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  const update = db.prepare('UPDATE profile_facts SET value=?, source=?, updated_at=? WHERE id=?');
  for (const fact of facts) {
    const previous = find.get(String(userId), fact.key);
    if (previous) {
      update.run(fact.value, fact.source || previous.source, at, previous.id);
      const next = projectRow(find.get(String(userId), fact.key));
      changes.push({action: 'update', entity: 'profile_facts', entityId: next.id, oldValues: projectRow(previous), newValues: next});
    } else {
      const id = randomUUID();
      insert.run(id, String(userId), fact.key, fact.value, fact.source || '', at, at);
      const next = projectRow(find.get(String(userId), fact.key));
      changes.push({action: 'create', entity: 'profile_facts', entityId: id, oldValues: null, newValues: next});
    }
  }
  if (changes.length !== facts.length) throw new WriteError('WRITE_FAILED', '画像写入没有覆盖全部条目，已整体回滚。', 500);
  return changes;
}
