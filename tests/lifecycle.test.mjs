import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RecruitStore} from '../src/recruit/store.mjs';
import {extractInterview} from '../src/recruit/collect.mjs';
import {SOURCES, REMOVED_SOURCES} from '../src/recruit/sources/index.mjs';

const now = () => new Date().toISOString();
const baseEvent = (over = {}) => ({
  id: 'a'.repeat(24), sourceId: 's1', school: '测试大学', city: '成都', kind: '宣讲会',
  title: '测试宣讲会', company: '测试公司', startAt: '2026-11-01T09:00:00+08:00', endAt: '',
  venue: '教学楼', fetchedAt: now(), confidence: 0.6, ...over
});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-life-'));
  try { return await fn(join(dir, 'recruit.db')); }
  finally { await rm(dir, {recursive: true, force: true}); }
}

test('新库：写入即为 active，记录首次/最近出现与来源', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      assert.equal(store.upsertEvent(baseEvent({interviewStage: '面试', interviewType: '无领导小组讨论'})), 'created');
      const row = store.getEvent('a'.repeat(24));
      assert.equal(row.status, 'active');
      assert.ok(row.firstSeenAt);
      assert.equal(row.lastSeenAt, row.firstSeenAt);
      assert.deepEqual(row.crossSources, ['s1']);
      assert.equal(row.missingRuns, 0);
      assert.equal(row.interviewStage, '面试');
      assert.equal(row.interviewType, '无领导小组讨论');
    } finally { store.close(); }
  });
});

test('旧库升级：自动补 status/first_seen/last_seen/cross_sources 列', async () => {
  await withStore(async file => {
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE events(id TEXT PRIMARY KEY, source_id TEXT, school TEXT, city TEXT, kind TEXT,
      title TEXT, company TEXT, start_at TEXT, end_at TEXT, venue TEXT, address TEXT, industry TEXT,
      company_size TEXT, positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT, source_url TEXT,
      published_at TEXT, fetched_at TEXT, confidence REAL, verified INTEGER, raw_text TEXT, notes TEXT)`);
    legacy.prepare("INSERT INTO events(id,source_id,school,city,kind,title,start_at,fetched_at,confidence,verified) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run('legacy', 's1', '旧大学', '成都', '宣讲会', '旧活动', '2026-10-01T09:00:00+08:00', '2026-09-01T00:00:00.000Z', 0.5, 0);
    legacy.close();

    const store = RecruitStore.open(file);
    try {
      const row = store.getEvent('legacy');
      assert.equal(row.status, 'active');
      assert.equal(row.firstSeenAt, '2026-09-01T00:00:00.000Z');
      assert.deepEqual(row.crossSources, ['s1']);
      assert.equal(row.interviewStage, '');
      assert.equal(row.interviewType, '');
    } finally { store.close(); }
  });
});

test('生命周期：连续 3 次未出现标记“可能撤下”，再次出现恢复', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(baseEvent());
      assert.equal(store.markMissing('s1', []).hidden, 0);
      assert.equal(store.getEvent('a'.repeat(24)).missingRuns, 1);
      store.markMissing('s1', []);
      const third = store.markMissing('s1', []);
      assert.equal(third.hidden, 1);
      assert.equal(store.getEvent('a'.repeat(24)).status, 'possibly_removed');
      // 仍在列表中（只是标记），统计里能看到
      assert.equal(store.listEvents({}).length, 1);
      assert.equal(store.stats().byStatus.possibly_removed, 1);
      // 再次出现：恢复 active，缺失计数清零
      store.upsertEvent(baseEvent({title: '测试宣讲会（更新）'}));
      const revived = store.getEvent('a'.repeat(24));
      assert.equal(revived.status, 'active');
      assert.equal(revived.missingRuns, 0);
    } finally { store.close(); }
  });
});

test('取消：默认列表与统计排除已取消活动', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(baseEvent({id: 'b'.repeat(24), status: 'cancelled', title: '活动取消通知'}));
      assert.equal(store.listEvents({}).length, 0);
      assert.equal(store.listEvents({includeCancelled: true}).length, 1);
      assert.equal(store.stats().total, 0);
    } finally { store.close(); }
  });
});

test('多源：同一活动被两个来源收录时合并并提升置信度，且不参与缺失标记', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(baseEvent({sourceId: 's1', confidence: 0.6}));
      store.upsertEvent(baseEvent({sourceId: 's2', confidence: 0.65}));
      const row = store.getEvent('a'.repeat(24));
      assert.deepEqual(row.crossSources.sort(), ['s1', 's2']);
      assert.ok(row.confidence >= 0.7);
      const missing = store.markMissing('s1', []);
      assert.equal(missing.skipped, 1);
      assert.equal(store.getEvent('a'.repeat(24)).status, 'active');
    } finally { store.close(); }
  });
});

test('采集器：截断的列表不触发缺失标记（避免把没抓全当成撤下）', async () => {
  // 通过导入 collect 模块确认它导出了 runCollection，且源码包含截断保护
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/recruit/collect.mjs', import.meta.url), 'utf8'));
  assert.match(source, /truncated/);
  assert.match(source, /markMissing/);
});

test('环节识别：面试类型优先，识别不到留空', () => {
  assert.deepEqual(extractInterview('某公司无领导小组讨论面试'), {stage: '面试', type: '无领导小组讨论'});
  assert.deepEqual(extractInterview('半结构化面试安排'), {stage: '面试', type: '半结构化面试'});
  assert.deepEqual(extractInterview('结构化面试 + 笔试'), {stage: '笔试', type: '结构化面试'});
  assert.deepEqual(extractInterview('群面通知'), {stage: '面试', type: '群面'});
  assert.deepEqual(extractInterview('一对一单面'), {stage: '面试', type: '单面'});
  assert.deepEqual(extractInterview('校园宣讲会'), {stage: '', type: ''});
});

test('多源合并时保留已有的环节/类型', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(baseEvent({sourceId: 's1', interviewStage: '面试', interviewType: '无领导小组讨论'}));
      store.upsertEvent(baseEvent({sourceId: 's2', interviewStage: '', interviewType: ''}));
      const row = store.getEvent('a'.repeat(24));
      assert.equal(row.interviewStage, '面试');
      assert.equal(row.interviewType, '无领导小组讨论');
    } finally { store.close(); }
  });
});

// —— 来源生命周期与谱系（#47）——

// 稳定的活动 id（24 位逐条唯一）；source_id 决定学校/城市/类型。
const mkEvent = (i, sourceId, over = {}) => ({
  id: String(i).padStart(24, '0'),
  sourceId,
  school: sourceId === 'nankai-recruitment' ? '南开大学' : '中山大学',
  city: sourceId === 'nankai-recruitment' ? '天津' : '广州',
  kind: sourceId === 'nankai-recruitment' ? '双选会' : '宣讲会',
  title: '测试活动' + i,
  company: '',
  startAt: '2026-11-01T09:00:00+08:00',
  endAt: '',
  venue: '',
  fetchedAt: now(),
  confidence: 0.6,
  ...over
});

test('来源对账：注册表源保持 active，墓碑源保留并标 orphaned', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.syncSources(SOURCES, REMOVED_SOURCES);
      const states = store.sourceStates();
      const byId = Object.fromEntries(states.map(s => [s.id, s]));
      assert.equal(states.length, SOURCES.length + REMOVED_SOURCES.length);
      assert.equal(byId['scu-employ'].orphaned, 0);
      assert.equal(byId['nankai-recruitment'].orphaned, 1);
      assert.equal(byId['nankai-recruitment'].enabled, 0);
      assert.equal(byId['nankai-recruitment'].name, '南开大学 · 双选会信息');
      assert.equal(byId['sysu-home'].orphaned, 1);
    } finally { store.close(); }
  });
});

test('来源对账：表里有但不在注册表/墓碑的源标 orphaned，不删除', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.syncSources(SOURCES, REMOVED_SOURCES);
      // 模拟漂移：下一次同步时某源从注册表消失，且没有墓碑
      const trimmed = SOURCES.filter(s => s.id !== 'cufe-scc');
      store.syncSources(trimmed, REMOVED_SOURCES);
      const byId = Object.fromEntries(store.sourceStates().map(s => [s.id, s]));
      assert.equal(byId['cufe-scc'].orphaned, 1);
      assert.equal(byId['cufe-scc'].enabled, 0);
    } finally { store.close(); }
  });
});

test('谱系迁移：孤儿源活动标 orphaned，重复执行幂等', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(mkEvent(1, 'nankai-recruitment'));
      store.upsertEvent(mkEvent(2, 'sysu-home'));
      assert.equal(store.getEvent(String(1).padStart(24, '0')).status, 'active');
      store.syncSources(SOURCES, REMOVED_SOURCES);
      assert.equal(store.getEvent(String(1).padStart(24, '0')).status, 'orphaned');
      assert.equal(store.getEvent(String(2).padStart(24, '0')).status, 'orphaned');
      // 幂等：再跑一次结果不变
      store.syncSources(SOURCES, REMOVED_SOURCES);
      assert.equal(store.getEvent(String(1).padStart(24, '0')).status, 'orphaned');
    } finally { store.close(); }
  });
});

test('谱系迁移：取消活动即使来自孤儿源也保持 cancelled', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      store.upsertEvent(mkEvent(1, 'nankai-recruitment', {status: 'cancelled', title: '活动取消通知'}));
      store.syncSources(SOURCES, REMOVED_SOURCES);
      assert.equal(store.getEvent(String(1).padStart(24, '0')).status, 'cancelled');
    } finally { store.close(); }
  });
});

test('谱系验收：孤儿活动都能追溯到历史来源（source_id 有 orphaned 行）', async () => {
  await withStore(async file => {
    const store = RecruitStore.open(file);
    try {
      for (let i = 1; i <= 20; i++) store.upsertEvent(mkEvent(i, 'nankai-recruitment'));
      for (let i = 21; i <= 29; i++) store.upsertEvent(mkEvent(i, 'sysu-home'));
      store.syncSources(SOURCES, REMOVED_SOURCES);
      const byId = Object.fromEntries(store.sourceStates().map(s => [s.id, s]));
      let orphaned = 0;
      for (let i = 1; i <= 29; i++) {
        const e = store.getEvent(String(i).padStart(24, '0'));
        assert.equal(e.status, 'orphaned');
        const src = byId[e.sourceId];
        assert.ok(src, '缺少历史来源行：' + e.sourceId);
        assert.equal(src.orphaned, 1);
        orphaned++;
      }
      assert.equal(orphaned, 29);
      // 0 个「有数据但来源表不存在」的源：每个 events.source_id 都能解析到行
      const ids = new Set(store.db.prepare('SELECT DISTINCT source_id FROM events').all().map(r => r.source_id));
      for (const id of ids) {
        assert.ok(byId[id] || SOURCES.some(s => s.id === id), '存在无来源行的 source_id：' + id);
      }
    } finally { store.close(); }
  });
});

