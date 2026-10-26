import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecruitStore} from '../src/recruit/store.mjs';
import {SOURCES} from '../src/recruit/sources/index.mjs';
import {collectSource} from '../src/recruit/collect.mjs';

// Windows 下 WAL 的 -shm 文件在关闭后可能短暂被占，这里只做测试清理的重试，不涉及业务。
async function cleanup(dir, store) {
  try { store?.close(); } catch { /* 已关闭 */ }
  for (let i = 0; i < 20; i++) {
    try { await rm(dir, {recursive: true, force: true}); return; }
    catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

async function openStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-fresh-'));
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  t.after(() => cleanup(dir, store));
  return {dir, store};
}

// 与 store 里一致的「今天」口径（+08:00 日期）。
const beijingToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

test('markSource：成功写最近尝试/成功与抓取、新增、更新数；失败不清空最近成功', async t => {
  const {store} = await openStore(t);
  store.syncSources(SOURCES);
  const id = 'scu-employ';

  store.markSource(id, {status: 'ok', error: '', fetched: 15, created: 3, updated: 12});
  let row = store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  assert.equal(row.last_status, 'ok');
  assert.ok(row.last_attempt, '成功要写最近尝试时间');
  assert.ok(row.last_success, '成功要写最近成功时间');
  assert.equal(row.last_fetched, 15);
  assert.equal(row.last_created, 3);
  assert.equal(row.last_updated, 12);
  assert.equal(row.last_count, 15, '兼容字段 last_count 仍等于抓取条数');

  const firstSuccess = row.last_success;
  await new Promise(r => setTimeout(r, 5));
  store.markSource(id, {status: 'error', error: '网络超时', fetched: 0});
  row = store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  assert.equal(row.last_status, 'error');
  assert.equal(row.last_success, firstSuccess, '失败要保留最近一次成功时间');
  assert.ok(row.last_attempt, '失败仍写最近尝试时间');
});

test('sourceStates：数据年龄与「今日有活动但数据超 24h」标黄', async t => {
  const {store} = await openStore(t);
  store.syncSources(SOURCES);
  const id = 'scu-employ';
  const today = beijingToday();
  store.upsertEvent({
    id: 'ev-today', sourceId: id, school: '四川大学', city: '成都', kind: '宣讲会',
    title: '今天的宣讲', company: '甲公司', startAt: today + 'T09:00:00+08:00', venue: '体育馆',
    fetchedAt: new Date().toISOString(), confidence: 0.7
  });

  // 30 小时前成功采集 → 数据超 24h，且有今日活动 → 标黄。
  const oldSuccess = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  store.db.prepare('UPDATE sources SET last_success=?, last_attempt=? WHERE id=?').run(oldSuccess, oldSuccess, id);
  let s = store.sourceStates().find(x => x.id === id);
  assert.equal(s.hasEventsToday, true);
  assert.equal(s.stale, true, '今日有活动且数据超 24h 要标黄');
  assert.ok(s.dataAgeMinutes >= 24 * 60, '数据年龄要按分钟给出且超过 1440');
  assert.equal(s.lastSuccess, oldSuccess);

  // 刚刚成功采集 → 不再标黄。
  const justNow = new Date().toISOString();
  store.db.prepare('UPDATE sources SET last_success=?, last_attempt=? WHERE id=?').run(justNow, justNow, id);
  s = store.sourceStates().find(x => x.id === id);
  assert.equal(s.hasEventsToday, true);
  assert.equal(s.stale, false, '刚刚刷新过不标黄');
  assert.ok(s.dataAgeMinutes < 24 * 60);

  // 从未成功采集但有今日活动 → 也按超 24h 标黄。
  store.db.prepare('UPDATE sources SET last_success=NULL, last_attempt=NULL WHERE id=?').run(id);
  s = store.sourceStates().find(x => x.id === id);
  assert.equal(s.stale, true);
  assert.equal(s.dataAgeMinutes, null);

  // 没有今日活动的源，即使数据老也不标黄。
  const otherId = 'swpu-xjh';
  store.db.prepare('UPDATE sources SET last_success=NULL WHERE id=?').run(otherId);
  const other = store.sourceStates().find(x => x.id === otherId);
  assert.equal(other.hasEventsToday, false);
  assert.equal(other.stale, false, '没有今日活动不标黄');
});

async function startServer(t) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
    res.end(JSON.stringify({items: [{title: '测试宣讲会', startAt: '2026-11-01T09:00:00+08:00', venue: '体育馆'}]}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return 'http://127.0.0.1:' + server.address().port;
}

function jsonSource(base, id) {
  return {
    id, name: id, school: '测试大学', city: '成都', category: '四川双一流', channel: '测试',
    kind: '宣讲会', mode: 'json', enabled: true, listUrl: base + '/list',
    parseList(_html, _source, json) { return json.items; }
  };
}

test('采集运行写最近尝试/成功与 fetched/created/updated', async t => {
  const base = await startServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'zx-fresh-'));
  await collectSource(jsonSource(base, 'scu-employ'), {dir, limit: 10});
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  t.after(() => cleanup(dir, store));
  const row = store.db.prepare('SELECT * FROM sources WHERE id=?').get('scu-employ');
  assert.equal(row.last_status, 'ok');
  assert.ok(row.last_attempt, '采集后要写最近尝试时间');
  assert.ok(row.last_success, '采集后要写最近成功时间');
  assert.equal(row.last_fetched, 1);
  assert.equal(row.last_created, 1);
  assert.equal(row.last_updated, 0);
  const enriched = store.sourceStates().find(x => x.id === 'scu-employ');
  assert.equal(enriched.lastFetched, 1);
  assert.equal(enriched.lastCreated, 1);
  assert.equal(enriched.lastUpdated, 0);
});

test('GET /api/recruit/sources 返回每源新鲜度字段', async t => {
  const {dir, store} = await openStore(t);
  store.syncSources(SOURCES);
  store.markSource('scu-employ', {status: 'ok', fetched: 5, created: 2, updated: 3});
  store.close();
  const {handleRecruit} = await import('../src/recruit/api.mjs');
  const res = await handleRecruit({method: 'GET', pathname: 'sources', url: new URL('http://x/sources'), body: null, dir});
  assert.equal(res.json.sources.length, 13, '13 个源都返回');
  const s = res.json.sources.find(x => x.id === 'scu-employ');
  assert.equal(s.lastFetched, 5);
  assert.equal(s.lastCreated, 2);
  assert.equal(s.lastUpdated, 3);
  assert.ok(s.lastAttempt, 'API 要给出最近尝试时间');
  assert.ok(s.lastSuccess, 'API 要给出最近成功时间');
  assert.equal(typeof s.stale, 'boolean');
  assert.equal(typeof s.hasEventsToday, 'boolean');
  assert.ok('dataAgeMinutes' in s);
});
