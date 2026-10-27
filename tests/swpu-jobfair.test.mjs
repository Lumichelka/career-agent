import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import source, {parseCompanies} from '../src/recruit/sources/swpu-jobfair.mjs';
import {collectSource, eventId, normalize} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const fairs = JSON.parse(readFileSync(new URL('./fixtures/swpu-jobfairs.json', import.meta.url), 'utf8'));
const companies = JSON.parse(readFileSync(new URL('./fixtures/swpu-companies.json', import.meta.url), 'utf8'));

test('SWPU 双选会：列表解析为活动', () => {
  const items = source.parseList('', source, fairs);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, '双选会');
  assert.match(items[0].title, /硕博人才/);
  assert.equal(items[0].startAt, '2026-10-29T09:00:00+08:00');
  assert.equal(items[0].url, 'https://jyzx.swpu.edu.cn/detail/jobfair?id=30916');
  assert.equal(items[0].sourceKey, '30916');
});

test('SWPU 双选会：参会单位解析为项目（岗位/要求/投递方式）', () => {
  const projects = parseCompanies(companies);
  assert.equal(projects.length, 3);
  assert.equal(projects[0].company, '深圳市朗驰欣创科技股份有限公司成都分公司');
  // 岗位名称来自 job_name
  assert.equal(projects[0].title, '管培生（研发）');
  assert.ok(projects[0].positions.includes('管培生（研发）'));
  assert.ok(projects[0].positions.includes('薪资 8K-12K/月'));
  assert.ok(projects[0].positions.includes('招聘 2 人'));
  // 要求来自学历 + 专业
  assert.ok(projects[0].requirements.includes('学历 本科及以上'));
  assert.ok(projects[0].requirements.includes('专业 电气工程及其自动化'));
  // 投递方式来自 publish_type
  assert.equal(projects[0].applyMode, '现场');
  assert.match(projects[0].notes, /信息传输/);
  assert.match(projects[0].notes, /A01/);
  assert.equal(projects[1].sourceKey, '6763299');
  assert.equal(projects[1].applyMode, '现场');
});

test('SWPU 双选会：读不到岗位/要求时留空并标「未公布」', () => {
  const projects = parseCompanies(companies);
  const empty = projects[2];
  assert.equal(empty.title, '');
  assert.equal(empty.positions, '');
  assert.equal(empty.requirements, '');
  assert.match(empty.notes, /岗位未公布/);
  assert.match(empty.notes, /要求未公布/);
});

test('SWPU 双选会：fetchProjects 分页覆盖 500+ 项目且短页即止', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = Number(u.searchParams.get('start')) || 1;
    const count = Number(u.searchParams.get('count')) || 50;
    // 前 11 页满 50 条，第 12 页只有 30 条（短页终止）
    const n = page <= 11 ? count : (page === 12 ? 30 : 0);
    const data = Array.from({length: n}, (_, i) => ({
      company_name: '公司' + page + '-' + i,
      jobfair_apply_job_id: String(page * 1000 + i),
      job_name: '岗位' + page + '-' + i,
      publish_type: '现场招聘'
    }));
    return {ok: true, status: 200, text: JSON.stringify({code: 1, data})};
  };
  const item = {url: 'https://jyzx.swpu.edu.cn/detail/jobfair?id=30916', projectCount: 2};
  const got = await source.fetchProjects(item, undefined, {fetchText: fetch, base: 'http://mock'});
  assert.equal(got.status, 'ok');
  assert.equal(got.projects.length, 11 * 50 + 30);
  assert.equal(calls.length, 12);
  assert.ok(calls[0].includes('start=1'));
  assert.ok(calls[1].includes('start=2'));
  assert.ok(calls[11].includes('start=12'));
});

test('SWPU 双选会：第一页全过去时翻到第二页取未来场次', async () => {
  const dayOffset = n => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
  const past = Array.from({length: 20}, (_, i) => ({
    fair_id: 1000 + i,
    title: '过去双选会' + i,
    meet_day: dayOffset(-20 + i),
    meet_time: '09:00:00'
  }));
  const future = [
    {fair_id: 2001, title: '未来双选会A#', meet_day: dayOffset(2), meet_time: '09:00:00'},
    {fair_id: 2002, title: '未来双选会B', meet_day: dayOffset(3), meet_time: '09:00:00'},
    {fair_id: 2003, title: '未来双选会C', meet_day: dayOffset(4), meet_time: '09:00:00'}
  ];
  const calls = [];
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('User-agent: *\nAllow: /\n');
    }
    calls.push(req.url);
    const u = new URL(req.url, 'http://mock');
    const start = Number(u.searchParams.get('start')) || 1;
    const list = start === 1 ? past : start === 2 ? future : [];
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({code: 1, data: {list}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'zx-swpu-window-'));
  try {
    const testSource = {
      ...source,
      id: 'swpu-test',
      listUrl: base + '/module/getjobfairs?start=1&count=20&with_counts=1',
      maxPages: 100,
      fetchProjects: undefined
    };
    // 旧版本存过带尾部 # 的活动：清洗标题后 eventId 不变，应原地更新而不是新增一行。
    const oldTitle = '未来双选会A#';
    const oldStartAt = dayOffset(2) + 'T09:00:00+08:00';
    const oldId = eventId({school: testSource.school, title: oldTitle, startAt: oldStartAt, venue: ''});
    const seed = RecruitStore.open(join(dir, 'recruit.db'));
    try { seed.upsertEvent(normalize({title: oldTitle, startAt: oldStartAt, city: testSource.city, kind: '双选会'}, testSource)); } finally { seed.close(); }
    const result = await collectSource(testSource, {dir});
    assert.equal(result.status, 'connected', result.message);
    assert.equal(result.fetched, 23);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({limit: 100});
      assert.equal(events.length, 23);
      const aRows = events.filter(event => event.title === '未来双选会A');
      assert.equal(aRows.length, 1, '清洗标题不能把旧行变成重复活动');
      assert.equal(aRows[0].id, oldId, '活动身份应仍由源标题决定');
      assert.equal(Number(aRows[0].missingRuns || 0), 0, '旧行应被本次采集命中');
      assert.ok(!events.some(event => event.title.endsWith('#')));
    } finally { store.close(); }
    assert.deepEqual(calls.filter(url => url.startsWith('/module/getjobfairs')), [
      '/module/getjobfairs?start=1&count=20&with_counts=1',
      '/module/getjobfairs?start=2&count=20&with_counts=1'
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});

test('SWPU 双选会：第 2 页失败抛出分类错误，不吞成半页成功', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      const list = Array.from({length: 20}, (_, i) => ({
        fair_id: 3000 + i,
        title: '活动' + i,
        meet_day: '2026-11-01',
        meet_time: '09:00:00'
      }));
      return {ok: true, status: 200, text: JSON.stringify({code: 1, data: {list}})};
    }
    return {ok: false, status: 403, reason: 'blocked', message: 'HTTP 403'};
  };
  await assert.rejects(
    () => source.fetchList({limit: 40, fetchText: fetch}),
    error => error.name === 'SourceError' && error.kind === 'blocked'
  );
  assert.equal(calls.length, 2);
});

test('SWPU 双选会：标题尾部 # 去掉', () => {
  const items = source.parseList('', source, {data: {list: [{fair_id: 1, title: '秋季双选会#', meet_day: '2026-11-01', meet_time: '09:00'}]}});
  assert.equal(items[0].title, '秋季双选会');
});

test('SWPU 双选会：声明项目能力', () => {
  assert.deepEqual(source.capabilities, {list: 'json', detail: 'http', projects: 'api'});
  assert.equal(typeof source.fetchProjects, 'function');
});
