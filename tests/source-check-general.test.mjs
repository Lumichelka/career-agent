import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {resolveSource, resolveSourceCheckTarget, SOURCE_CHECK_NOTES} from '../src/source-check/pipeline.mjs';
import {normalizeSourceCheckUrl, sourceCheckEnabled, sourceCheckConfig, selectDetailHref} from '../src/source-check/config.mjs';
import {buildExtractionPrompt, normalizeExtraction} from '../src/source-check/extract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('任意 URL 归一化：只接受 http/https，拒绝脚本/裸地址', () => {
  assert.equal(normalizeSourceCheckUrl('https://career.uibe.edu.cn/zhaopin/'), 'https://career.uibe.edu.cn/zhaopin/');
  assert.equal(normalizeSourceCheckUrl('  http://job3.swufe.edu.cn/jobfair/jobfair-list-.htm  '), 'http://job3.swufe.edu.cn/jobfair/jobfair-list-.htm');
  assert.equal(normalizeSourceCheckUrl('javascript:alert(1)'), null);
  assert.equal(normalizeSourceCheckUrl('data:text/html,hi'), null);
  assert.equal(normalizeSourceCheckUrl('file:///C:/x'), null);
  assert.equal(normalizeSourceCheckUrl('career.uibe.edu.cn'), null, '没有协议不接受');
  assert.equal(normalizeSourceCheckUrl('ftp://career.uibe.edu.cn'), null);
  assert.equal(normalizeSourceCheckUrl(''), null);
});

test('任意 URL：默认拒绝 loopback/私网/link-local，显式开关才放行', () => {
  for (const url of [
    'http://127.0.0.1:4189/admin',
    'http://localhost:3000/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/'
  ]) {
    assert.equal(normalizeSourceCheckUrl(url), null, url + ' 默认必须拒绝');
    assert.equal(normalizeSourceCheckUrl(url, {allowPrivate: true}), new URL(url).href, url + ' 显式开关下允许（人工确认后）');
  }
  assert.equal(normalizeSourceCheckUrl('https://career.uibe.edu.cn/zhaopin/'), 'https://career.uibe.edu.cn/zhaopin/', '公网地址不受影响');
  assert.equal(normalizeSourceCheckUrl('https://career.uibe.edu.cn.evil.local/'), null, '伪装域名不能绕过');
});

test('来源校对能力标记：财经院校与浏览器登录形态开放，采集器源不开放', () => {
  assert.equal(sourceCheckEnabled({sourceCheck: {enabled: true}}), true);
  assert.equal(sourceCheckEnabled({sourceCheck: true}), true);
  assert.equal(sourceCheckEnabled({sourceCheck: {enabled: false}}), false);
  assert.equal(sourceCheckEnabled({sourceCheck: false}), false);
  assert.equal(sourceCheckEnabled({}), false);
  const cfg = sourceCheckConfig({sourceCheck: {enabled: true, detailPattern: 'jobfair-show-\\d+\\.htm', participantTab: '参会企业', participantRequired: true}});
  assert.equal(cfg.detailPattern, 'jobfair-show-\\d+\\.htm');
  assert.equal(cfg.participantTab, '参会企业');
  assert.equal(cfg.participantRequired, true);
  for (const id of ['swufe-xjh', 'cufe-scc', 'uibe-career', 'ncss', 'iguopin']) {
    assert.equal(sourceCheckEnabled(resolveSource(id)), true, id + ' 应开放来源校对');
  }
  for (const id of ['sufe-xjh', 'scu-employ', 'scu-jobfair']) {
    assert.equal(sourceCheckEnabled(resolveSource(id)), false, id + ' 走采集器，不应开放来源校对');
  }
});

test('resolveSource：别名归一并接受任意已开放源', () => {
  assert.equal(resolveSource('swufe').id, 'swufe-xjh');
  assert.equal(resolveSource('swufe-xjh').id, 'swufe-xjh');
  assert.equal(resolveSource('cufe-scc').id, 'cufe-scc');
  assert.equal(resolveSource('iguopin').id, 'iguopin');
  assert.equal(resolveSource('nossuch-source'), null);
  assert.equal(resolveSource('sufe-xjh'), null, '采集器源不能走来源校对');
});

test('resolveSourceCheckTarget：任意 URL 生成合成源；未知源/非法 URL 报错', () => {
  const byUrl = resolveSourceCheckTarget({url: 'https://career.uibe.edu.cn/zhaopin/'});
  assert.equal(byUrl.kind, 'url');
  assert.equal(byUrl.source.listUrl, 'https://career.uibe.edu.cn/zhaopin/');
  assert.equal(byUrl.source.id, 'manual');
  assert.equal(byUrl.source.school, '');
  assert.equal(byUrl.source.city, '');
  assert.equal(byUrl.source.kind, '');
  assert.equal(byUrl.source.arbitrary, true);
  assert.match(byUrl.source.name, /career\.uibe\.edu\.cn/);

  const bySource = resolveSourceCheckTarget({sourceId: 'cufe-scc'});
  assert.equal(bySource.kind, 'source');
  assert.equal(bySource.source.id, 'cufe-scc');

  const badUrl = resolveSourceCheckTarget({url: 'javascript:alert(1)'});
  assert.equal(badUrl.error.code, 'INVALID_URL');

  const unknown = resolveSourceCheckTarget({sourceId: 'nope'});
  assert.equal(unknown.error.code, 'UNSUPPORTED_SOURCE');
});

test('selectDetailHref：显式 pattern 优先，否则启发式跳过登录/资源链接', () => {
  const links = [
    {href: 'https://site.edu.cn/login', text: '登录'},
    {href: 'https://site.edu.cn/style.css', text: ''},
    {href: 'https://site.edu.cn/zhaopin/2026-05-12', text: '中国银行宣讲会'},
    {href: 'https://site.edu.cn/jobfair/jobfair-show-123.htm', text: '双选会详情'},
    {href: 'https://site.edu.cn/about', text: '关于我们'}
  ];
  assert.equal(selectDetailHref(links, {pattern: 'jobfair-show-\\d+\\.htm'}), 'https://site.edu.cn/jobfair/jobfair-show-123.htm');
  assert.equal(selectDetailHref(links), 'https://site.edu.cn/jobfair/jobfair-show-123.htm', '活动文案 + 数字/详情路径优先');
  assert.equal(selectDetailHref([{href: 'https://site.edu.cn/login', text: ''}]), '', '只剩登录链接时不选');
  assert.equal(selectDetailHref([]), '');
  assert.equal(selectDetailHref([{href: 'javascript:void(0)', text: '详情'}]), '');
});

test('抽取默认值跟随来源：任意源不硬套西南财大默认', () => {
  const raw = {events: [{title: '对外经贸2026届双选会', startAt: '2026-11-01T09:00:00+08:00'}], projects: []};
  const generic = normalizeExtraction(raw, {source: {id: 'uibe-career', school: '对外经济贸易大学', city: '北京', kind: '双选会'}, detailUrl: ''});
  assert.equal(generic.events[0].school, '对外经济贸易大学');
  assert.equal(generic.events[0].city, '北京');
  assert.equal(generic.events[0].kind, '双选会');
  const arbitrary = normalizeExtraction(raw, {source: {id: 'manual', school: '', city: '', kind: ''}, detailUrl: ''});
  assert.equal(arbitrary.events[0].school, '', '任意源没有默认学校');
  assert.equal(arbitrary.events[0].city, '');
  assert.equal(arbitrary.events[0].kind, '');
  assert.ok(!buildExtractionPrompt({name: '任意网页'} ).includes('西南财经大学'), '任意源 prompt 不硬编码西南财大');
});

// ---- 任意 URL 端到端 ----

async function startApp(t, sourceCheck) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-sc-general-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, sourceCheck});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  assert.equal(response.status, 200, name + ' 注册失败');
  return {user: (await response.json()).user, cookie: cookieOf(response)};
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function postJson(app, path, cookie, body, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 状态不符：' + JSON.stringify(payload));
  return payload;
}

async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const payload = await response.json();
  assert.equal(response.status, 200, path + ' 失败：' + JSON.stringify(payload));
  return payload;
}

async function waitFor(check, {timeoutMs = 20000, intervalMs = 40} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error('等待条件超时');
}

function fakeReader(detailUrl) {
  const calls = [];
  const reader = async ({source, evidenceDir}) => {
    calls.push({kind: 'list', url: source.listUrl});
    await mkdir(evidenceDir, {recursive: true});
    const at = new Date().toISOString();
    await writeFile(join(evidenceDir, '01-list.png'), PNG);
    calls.push({kind: 'detail', url: detailUrl});
    await writeFile(join(evidenceDir, '02-detail.png'), PNG);
    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: join(evidenceDir, '01-list.png'), url: source.listUrl, title: '招聘列表', at, viewport: {width: 1366, height: 900}},
        {id: 'detail', kind: 'screenshot', file: join(evidenceDir, '02-detail.png'), url: detailUrl, title: '对外经贸2026届秋季双选会', at, viewport: {width: 1366, height: 900}}
      ]
    };
  };
  reader.calls = calls;
  return reader;
}

function fakeExtractor() {
  return async () => ({
    events: [{title: '对外经贸2026届秋季双选会', startAt: '2026-11-01T09:00:00+08:00', school: '对外经济贸易大学', city: '北京', kind: '双选会'}],
    projects: [{eventRef: 0, company: '中国工商银行', title: '管培生', positions: '', requirements: '', applyMode: '', applyUrl: ''}]
  });
}

test('任意 URL 来源校对：入口接受 url，浏览器读两页 + 写库 source_id=manual，来源卡不误标', {timeout: 60000}, async t => {
  const url = 'https://career.uibe.edu.cn/zhaopin/list';
  const detailUrl = 'https://career.uibe.edu.cn/zhaopin/detail/123';
  const reader = fakeReader(detailUrl);
  const app = await startApp(t, {browserReader: reader, extractor: fakeExtractor()});
  const user = await register(app, 'arbitrary-url-user');

  const started = await postJson(app, '/api/source-check/start', user.cookie, {url});
  assert.equal(started.ok, true);
  assert.equal(started.sourceId, 'manual');
  assert.match(started.sessionId, /^[a-f0-9-]{36}$/);
  assert.match(started.title, /来源校对/);

  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    const task = listed.tasks[0];
    return listed.tasks.length && ['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.state) ? task : null;
  });
  assert.equal(finished.state, 'succeeded', '任意 URL 任务成功：' + JSON.stringify(finished.error));
  assert.equal(finished.counts.writes, 2, '1 场活动 + 1 个项目');

  // 浏览器读取的是用户给的那条 URL，不是 swufe。
  assert.deepEqual(reader.calls.map(call => call.kind), ['list', 'detail']);
  assert.equal(reader.calls[0].url, url);

  // 写库：source_id=manual、source_url=详情 URL、notes 标非采集器。
  const store = RecruitStore.open(join(app.dataDir, 'users', user.user.id, '.data', 'recruit.db'));
  let rows;
  try {
    rows = {
      events: store.db.prepare('SELECT * FROM events').all(),
      projects: store.db.prepare('SELECT * FROM event_projects').all()
    };
  } finally { store.close(); }
  assert.equal(rows.events.length, 1);
  assert.equal(rows.events[0].source_id, 'manual');
  assert.equal(rows.events[0].source_url, detailUrl);
  assert.match(rows.events[0].notes, /浏览器截图读取（非采集器）/);
  assert.equal(rows.events[0].school, '对外经济贸易大学', '学校不是硬套西南财大默认');
  assert.equal(rows.projects.length, 1);
  assert.equal(SOURCE_CHECK_NOTES, '浏览器截图读取（非采集器）');
});

test('非法 URL 与未知源入口返回 400，不排队任务', {timeout: 30000}, async t => {
  const app = await startApp(t, {browserReader: fakeReader('https://x/d'), extractor: fakeExtractor()});
  const user = await register(app, 'bad-url-user');
  const bad = await postJson(app, '/api/source-check/start', user.cookie, {url: 'javascript:alert(1)'}, 400);
  assert.equal(bad.code, 'INVALID_URL');
  const unknown = await postJson(app, '/api/source-check/start', user.cookie, {sourceId: 'nope'}, 400);
  assert.equal(unknown.code, 'UNSUPPORTED_SOURCE');
  const tasks = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(tasks.tasks.length, 0, '非法请求不产生任务');
});

test('来源卡 catalog：财经院校与浏览器登录形态都标记 sourceCheck，采集器源不标记', {timeout: 30000}, async t => {
  const app = await startApp(t, {browserReader: fakeReader('https://x/d'), extractor: fakeExtractor()});
  const user = await register(app, 'catalog-user');
  const sources = await getJson(app, '/api/recruit/sources', user.cookie);
  for (const id of ['swufe-xjh', 'cufe-scc', 'uibe-career', 'ncss', 'iguopin']) {
    assert.equal(sources.catalog[id].sourceCheck, true, id + ' catalog 应标记 sourceCheck');
  }
  for (const id of ['sufe-xjh', 'scu-employ']) {
    assert.equal(sources.catalog[id].sourceCheck, false, id + ' catalog 不应标记 sourceCheck');
  }
});
