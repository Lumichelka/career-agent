import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectSource, runCollection} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {SourceError} from '../src/recruit/sources/error.mjs';
import {SOURCES} from '../src/recruit/sources/index.mjs';
import {
  SOURCE_STATUSES,
  isFailedSourceStatus,
  isSuccessfulSourceStatus,
  normalizeSourceStatus,
  sourceStatusLabel
} from '../src/recruit/source-status.mjs';

const SRC_ID = 'scu-jobfair';
const ITEM = {
  id: 'fair-1',
  title: '测试双选会',
  startAt: '2026-11-01T09:00:00+08:00',
  venue: '体育馆',
  url: 'https://example.test/fair/1'
};

function source({fetchList, fetchProjects, ...extra} = {}) {
  return {
    id: SRC_ID,
    name: '测试双选会源',
    school: '测试大学',
    city: '成都',
    category: '四川双一流',
    channel: '测试',
    kind: '双选会',
    mode: 'json',
    enabled: true,
    listUrl: 'https://example.test/list',
    capabilities: {list: 'json', detail: 'http', projects: fetchProjects ? 'api' : 'none'},
    fetchList,
    fetchProjects,
    parseList() { return []; },
    ...extra
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-source-status-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

async function sourceRow(dir) {
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    return {
      row: store.db.prepare('SELECT * FROM sources WHERE id=?').get(SRC_ID),
      state: store.sourceStates().find(s => s.id === SRC_ID)
    };
  } finally { store.close(); }
}

test('来源状态词表：七个规格状态、中文标签与成功判定', () => {
  assert.deepEqual(SOURCE_STATUSES, [
    'connected', 'list_only', 'needs_login', 'blocked_robots', 'network_error', 'empty', 'disabled'
  ]);
  assert.deepEqual(
    SOURCE_STATUSES.map(sourceStatusLabel),
    ['已连通', '仅列表', '需登录', '被站点拦截', '网络或解析失败', '暂无活动', '未接入']
  );
  assert.equal(sourceStatusLabel(''), '待采集');
  assert.equal(sourceStatusLabel('ok'), '已连通', '旧库的 ok 仍按已连通显示');
  assert.equal(sourceStatusLabel('error'), '网络或解析失败', '旧库的 error 仍能显示中文');
  assert.equal(normalizeSourceStatus('disallowed'), 'blocked_robots');
  assert.equal(normalizeSourceStatus('blocked'), 'blocked_robots');
  assert.equal(normalizeSourceStatus('timeout'), 'network_error');
  for (const status of ['connected', 'empty', 'list_only']) assert.equal(isSuccessfulSourceStatus(status), true, status);
  for (const status of ['needs_login', 'blocked_robots', 'network_error', 'disabled']) assert.equal(isSuccessfulSourceStatus(status), false, status);
  assert.equal(isSuccessfulSourceStatus('ok'), true, '旧库的 ok 仍算成功');
  for (const status of ['network_error', 'blocked_robots', 'needs_login']) assert.equal(isFailedSourceStatus(status), true, status);
  for (const status of ['connected', 'empty', 'list_only', 'disabled']) assert.equal(isFailedSourceStatus(status), false, status);
});

test('采集器状态：disabled / needs_login / 空列表 / 无项目时 connected', async () => {
  const disabled = await collectSource(source({enabled: false, fetchList: async () => ({items: [ITEM]})}), {persist: false});
  assert.equal(disabled.status, 'disabled');

  const login = await collectSource(source({collectMode: 'manual', loginRequired: true}), {persist: false});
  assert.equal(login.status, 'needs_login');

  const empty = await collectSource(source({fetchList: async () => ({items: []})}), {persist: false});
  assert.equal(empty.status, 'empty');

  const connected = await collectSource(source({fetchList: async () => ({items: [ITEM]})}), {persist: false});
  assert.equal(connected.status, 'connected', '没有项目阶段的源解析到活动即已连通');
  assert.equal(connected.fetched, 1);
});

test('采集器状态：抓取失败按原因落到 blocked_robots / network_error', async () => {
  const cases = [
    ['login_required', 'needs_login'],
    ['blocked', 'blocked_robots'],
    ['network', 'network_error'],
    ['changed', 'network_error'],
    ['parse', 'network_error'],
    ['empty', 'empty']
  ];
  for (const [kind, expected] of cases) {
    const out = await collectSource(source({fetchList: async () => { throw new SourceError(kind, '测试失败'); }}), {persist: false});
    assert.equal(out.status, expected, kind);
  }
});

test('川大双选会接口可访问但没有参会单位：不算项目失败，来源仍然已连通', async () => {
  await withDir(async dir => {
    const out = await collectSource(source({
      fetchList: async () => ({items: [ITEM]}),
      fetchProjects: async () => ({status: 'none', message: '接口可访问，但没有参会单位', projects: []})
    }), {dir});

    assert.equal(out.status, 'connected');
    assert.equal(out.projectErrors, 0, '合法空项目不能计入失败');
    assert.equal(out.projectEvents, 1, '项目阶段执行完成就算一次成功');
    assert.equal(out.fetched, 1);

    const {row, state} = await sourceRow(dir);
    assert.equal(row.last_status, 'connected');
    assert.equal(row.failure_streak, 0);
    assert.ok(row.last_success, '空项目仍应更新最近成功时间');
    assert.equal(state.lastStatus, 'connected');
    assert.equal(state.lastStatusLabel, '已连通');
  });
});

test('项目阶段部分失败：活动仍入库，来源标“仅列表”而不是已连通', async () => {
  await withDir(async dir => {
    const second = {...ITEM, id: 'fair-2', title: '第二场双选会'};
    const out = await collectSource(source({
      fetchList: async () => ({items: [ITEM, second]}),
      fetchProjects: async item => {
        if (item.id === 'fair-1') throw new Error('第一场项目接口失败');
        return {status: 'ok', projects: [{company: '测试单位', title: '测试岗位', sourceKey: 'p-2'}]};
      }
    }), {dir});

    assert.equal(out.status, 'list_only', '有项目失败时不能标已连通');
    assert.equal(out.projectErrors, 1);
    assert.equal(out.projectEvents, 1);
    assert.match(out.message, /项目部分成功/);

    const {row, state} = await sourceRow(dir);
    assert.equal(row.last_status, 'list_only');
    assert.equal(state.lastStatusLabel, '仅列表');
  });
});

test('采集汇总：失败数按新状态词表统计，不再漏掉网络失败', async () => {
  await withDir(async dir => {
    const failing = {...source({fetchList: async () => { throw new SourceError('network', '断网'); }}), id: 'zz-test-fail', name: '测试失败源'};
    SOURCES.push(failing);
    try {
      const out = await runCollection({dir, sourceIds: ['zz-test-fail'], concurrency: 1});
      assert.equal(out.results[0].status, 'network_error');
      assert.equal(out.totals.failed, 1);
    } finally {
      SOURCES.pop();
    }
  });
});

test('旧调用 markSource(ok/error) 写回新词，来源表不再出现旧状态', async () => {
  await withDir(async dir => {
    await collectSource(source({fetchList: async () => ({items: [ITEM]})}), {dir});
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      store.markSource(SRC_ID, {status: 'ok', fetched: 1, created: 1});
      assert.equal(store.db.prepare('SELECT last_status FROM sources WHERE id=?').get(SRC_ID).last_status, 'connected');
      store.markSource(SRC_ID, {status: 'error', error: '超时', fetched: 0});
      const row = store.db.prepare('SELECT * FROM sources WHERE id=?').get(SRC_ID);
      assert.equal(row.last_status, 'network_error');
      assert.equal(row.failure_streak, 1);
    } finally { store.close(); }
  });
});

test('项目阶段抛错：活动仍入库，来源状态说清“仅列表”而不是已连通', async () => {
  await withDir(async dir => {
    const out = await collectSource(source({
      fetchList: async () => ({items: [ITEM]}),
      fetchProjects: async () => { throw new Error('参会单位接口挂了'); }
    }), {dir});

    assert.equal(out.status, 'list_only');
    assert.equal(out.projectErrors, 1);
    assert.equal(out.projectEvents, 0);
    assert.equal(out.fetched, 1);

    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00'});
      assert.equal(events.length, 1, '活动不受项目阶段失败影响');
    } finally { store.close(); }

    const {row, state} = await sourceRow(dir);
    assert.equal(row.last_status, 'list_only');
    assert.equal(row.failure_streak, 0, '活动列表成功，连续失败不应增加');
    assert.equal(state.lastStatusLabel, '仅列表');
  });
});
