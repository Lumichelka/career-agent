import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import source, {parseCompanies} from '../src/recruit/sources/swpu-jobfair.mjs';

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

test('SWPU 双选会：声明项目能力', () => {
  assert.deepEqual(source.capabilities, {list: 'json', detail: 'http', projects: 'api'});
  assert.equal(typeof source.fetchProjects, 'function');
});
