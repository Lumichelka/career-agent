import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import source, {parseCorporations} from '../src/recruit/sources/scu-jobfair.mjs';

const html = readFileSync(new URL('./fixtures/scu-corporations.html', import.meta.url), 'utf8');

test('川大双选会：参会单位解析', () => {
  const projects = parseCorporations(html);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].company, '浙江吉利控股集团有限公司');
  assert.match(projects[0].notes, /制造业/);
  assert.equal(projects[0].applyMode, '现场');
  assert.match(projects[0].sourceUrl, /jobfaircorporationinfo/);
});

test('川大双选会：声明项目能力', () => {
  assert.deepEqual(source.capabilities, {list: 'static', detail: 'http', projects: 'api'});
  assert.equal(typeof source.fetchProjects, 'function');
});
