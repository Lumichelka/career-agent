import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectSource} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

async function withServer(fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
    res.end(JSON.stringify({items: [{title: '测试双选会', startAt: '2026-11-01T09:00:00+08:00', venue: '体育馆'}]}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(r => server.close(r)); }
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
