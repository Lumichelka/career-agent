import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES, REMOVED_SOURCES, sourceById, enabledSources, CATEGORIES} from '../src/recruit/sources/index.mjs';
import {collectSource} from '../src/recruit/collect.mjs';

test('源注册表：自动发现 13 个源，id 唯一；自动采集仍 8 个', () => {
  assert.equal(SOURCES.length, 13);
  const ids = SOURCES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(SOURCES.filter(s => s.enabled).length, 10, '24365/国聘作为 browser 源开放');
  assert.equal(enabledSources().length, 8, '默认采集不包含需登录的人工源');
});

test('24365/国聘：browser 源骨架开放，但明确需登录/人工确认，不自动采集也不绕过登录', async () => {
  for (const id of ['ncss', 'iguopin']) {
    const source = sourceById(id);
    assert.equal(source.enabled, true, id + ' 应作为可用来源展示');
    assert.equal(source.mode, 'browser');
    assert.equal(source.loginRequired, true);
    assert.equal(source.manualConfirm, true);
    assert.equal(source.collectMode, 'manual');
    assert.equal(typeof source.parseList, 'function', 'browser 骨架保留 parseList 接缝');
    assert.match(source.note, /登录|人工/);
    assert.equal(source.capabilities.list, 'browser');
    const out = await collectSource(id, {dir: 'unused', persist: false});
    assert.equal(out.status, 'blocked');
    assert.match(out.message, /登录|人工确认/);
  }
});

test('每个源字段完整，已接入的必须有 parseList', () => {
  for (const source of SOURCES) {
    assert.ok(source.id, '缺 id');
    assert.ok(source.name, source.id + ' 缺 name');
    assert.ok(source.school, source.id + ' 缺 school');
    assert.ok(source.listUrl, source.id + ' 缺 listUrl');
    assert.ok(['static', 'json', 'browser', 'rss', 'manual'].includes(source.mode), source.id + ' mode 无效');
    assert.ok(CATEGORIES.includes(source.category), source.id + ' category 无效');
    if (source.enabled) {
      assert.equal(typeof source.parseList, 'function', source.id + ' 已接入但没有 parseList');
    } else {
      assert.ok(source.note, source.id + ' 未接入但没有说明原因');
    }
    if (source.fetchProjects) {
      assert.equal(typeof source.fetchProjects, 'function', source.id + ' fetchProjects 不是函数');
    }
  }
});

test('按 id 查找与错误提示', () => {
  assert.equal(sourceById('scu-employ').school, '四川大学');
  assert.throws(() => sourceById('nope'), /未知信息源/);
});

test('Web 前端使用的目录元数据齐全', () => {
  const catalog = Object.fromEntries(SOURCES.map(s => [s.id, {category: s.category, channel: s.channel, fallback: s.fallback || '', note: s.note || ''}]));
  assert.equal(catalog['sufe-xjh'].category, '财经强校');
  assert.equal(catalog['cufe-scc'].fallback.length > 0, true);
});

test('已下线来源墓碑：南开/中山源码已移除但谱系保留', () => {
  assert.equal(REMOVED_SOURCES.length, 2);
  assert.deepEqual(REMOVED_SOURCES.map(s => s.id).sort(), ['nankai-recruitment', 'sysu-home']);
  for (const s of REMOVED_SOURCES) {
    assert.equal(s.enabled, false);
    assert.ok(s.name && s.school && s.listUrl);
    assert.ok(!SOURCES.some(x => x.id === s.id), s.id + ' 不应同时出现在当前注册表');
  }
});
