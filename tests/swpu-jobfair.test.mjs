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

test('SWPU 双选会：参会单位解析为项目', () => {
  const projects = parseCompanies(companies);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].company, '深圳市朗驰欣创科技股份有限公司成都分公司');
  assert.match(projects[0].notes, /信息传输/);
  assert.match(projects[0].notes, /A01/);
  assert.equal(projects[1].sourceKey, '6763299');
});

test('SWPU 双选会：声明项目能力', () => {
  assert.deepEqual(source.capabilities, {list: 'json', detail: 'http', projects: 'api'});
  assert.equal(typeof source.fetchProjects, 'function');
});
