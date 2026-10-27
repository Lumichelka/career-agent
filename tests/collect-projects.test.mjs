import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectSource} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

async function withServerItems(items, fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
    res.end(JSON.stringify({items}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(r => server.close(r)); }
}

async function withServer(fn) {
  return withServerItems([{title: '测试双选会', startAt: '2026-11-01T09:00:00+08:00', venue: '体育馆'}], fn);
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-collect-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

function source(base, id, fetchProjects) {
  return {
    id, name: id, school: '测试大学', city: '成都', category: '四川双一流', channel: '测试',
    kind: '双选会', mode: 'json', enabled: true, listUrl: base + '/list',
    parseList(_html, _source, json) { return json.items; },
    fetchProjects
  };
}

test('采集项目阶段：活动入库后自动写项目', async () => {
  await withServer(async base => withDir(async dir => {
    await collectSource(source(base, 'test-project-ok', async () => ({
      status: 'ok',
      projects: [{company: '甲公司', title: '数据分析', sourceKey: 'a1'}]
    })), {dir, limit: 1});
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].projects.length, 1);
      assert.equal(events[0].projects[0].sourceId, 'test-project-ok');
    } finally { store.close(); }
  }));
});

test('采集项目阶段失败：活动保留，项目为空', async () => {
  await withServer(async base => withDir(async dir => {
    const result = await collectSource(source(base, 'test-project-fail', async () => { throw new Error('接口挂了'); }), {dir, limit: 1});
    assert.equal(result.projectErrors, 1);
    assert.equal(result.projectEvents, 0);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].projects.length, 0);
    } finally { store.close(); }
  }));
});

test('项目阶段不受 12 场上限限制：所有未来场次都参与', async () => {
  const items = Array.from({length: 15}, (_, i) => ({
    title: `未来双选会${i + 1}`, startAt: '2026-11-05T09:00:00+08:00', venue: '体育馆'
  }));
  await withServerItems(items, async base => withDir(async dir => {
    let calls = 0;
    const result = await collectSource(source(base, 'test-project-many', async () => {
      calls++;
      return {status: 'ok', projects: [{company: `单位${calls}`, title: '岗位', sourceKey: `k${calls}`}]};
    }), {dir, now: '2026-10-28T09:00:00+08:00'});
    assert.equal(result.parsed, 15);
    assert.equal(result.fetched, 15);
    assert.equal(calls, 15, '15 场未来活动都要执行项目阶段');
    assert.equal(result.projectEvents, 15);
    assert.equal(result.projectErrors, 0);
    assert.equal(result.status, 'connected');
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 15);
      assert.equal(events.every(e => e.projects.length === 1), true);
    } finally { store.close(); }
  }));
});

test('20 场过去 + 3 场未来：23 场入库，只对未来 3 场跑项目阶段', async () => {
  const past = Array.from({length: 20}, (_, i) => ({
    title: `已结束双选会${i + 1}`, startAt: '2026-10-20T09:00:00+08:00', venue: '体育馆'
  }));
  const future = Array.from({length: 3}, (_, i) => ({
    title: `未来双选会${i + 1}`, startAt: `2026-11-0${i + 5}T09:00:00+08:00`, venue: '体育馆'
  }));
  await withServerItems([...past, ...future], async base => withDir(async dir => {
    const called = [];
    const result = await collectSource(source(base, 'test-project-window', async item => {
      called.push(item.title);
      return {status: 'ok', projects: [{company: '未来单位', title: '岗位', sourceKey: item.title}]};
    }), {dir, limit: 100, now: '2026-10-28T09:00:00+08:00'});
    assert.deepEqual(called, ['未来双选会1', '未来双选会2', '未来双选会3']);
    assert.equal(result.parsed, 23);
    assert.equal(result.projectEligible, 3);
    assert.equal(result.projectSkipped, 20);
    assert.equal(result.projectEvents, 3);
    assert.equal(result.projectErrors, 0);
    assert.equal(result.status, 'connected');
    assert.match(result.message, /20 场已结束/);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 23, '已结束活动仍然入库');
      assert.equal(events.filter(e => e.projects.length === 1).length, 3, '只有未来活动有项目');
      assert.equal(events.filter(e => e.title.startsWith('已结束')).every(e => e.projects.length === 0), true);
    } finally { store.close(); }
  }));
});

test('全部场次都已结束：项目阶段不执行，来源仍标已连通', async () => {
  await withServerItems([{title: '只有过去', startAt: '2026-10-20T09:00:00+08:00', venue: '体育馆'}], async base => withDir(async dir => {
    let calls = 0;
    const result = await collectSource(source(base, 'test-project-past', async () => { calls++; throw new Error('不应调用'); }), {dir, now: '2026-10-28T09:00:00+08:00'});
    assert.equal(calls, 0);
    assert.equal(result.projectEvents, 0);
    assert.equal(result.projectErrors, 0);
    assert.equal(result.projectSkipped, 1);
    assert.equal(result.status, 'connected');
    assert.match(result.message, /已结束/);
  }));
});

test('未来场次项目失败不影响其它场次与活动入库', async () => {
  const items = [
    {title: '未来双选会1', startAt: '2026-11-05T09:00:00+08:00', venue: '体育馆'},
    {title: '未来双选会2', startAt: '2026-11-06T09:00:00+08:00', venue: '体育馆'},
    {title: '未来双选会3', startAt: '2026-11-07T09:00:00+08:00', venue: '体育馆'}
  ];
  await withServerItems(items, async base => withDir(async dir => {
    let calls = 0;
    const result = await collectSource(source(base, 'test-project-partial', async item => {
      calls++;
      if (item.title === '未来双选会1') throw new Error('第一场项目接口失败');
      return {status: 'ok', projects: [{company: '单位', title: '岗位', sourceKey: item.title}]};
    }), {dir, now: '2026-10-28T09:00:00+08:00'});
    assert.equal(calls, 3, '单场失败后仍要继续后面的场次');
    assert.equal(result.projectEvents, 2);
    assert.equal(result.projectErrors, 1);
    assert.equal(result.status, 'list_only');
    assert.match(result.message, /项目部分成功/);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00'});
      assert.equal(events.length, 3);
    } finally { store.close(); }
  }));
});
