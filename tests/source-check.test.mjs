import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {resolveSource, writeSourceCheck, SOURCE_CHECK_NOTES} from '../src/source-check/pipeline.mjs';
import {SourceCheckBlockedError, BROWSER_LAUNCH_OPTIONS, BROWSER_CONTEXT_OPTIONS, detectBlock, openParticipantTab} from '../src/source-check/browser.mjs';
import {normalizeExtraction, stripContacts} from '../src/source-check/extract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const DETAIL_URL = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startApp(t, sourceCheck) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-source-check-'));
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

async function taskState(app, cookie) {
  const listed = await getJson(app, '/api/tasks', cookie);
  const task = listed.tasks[0];
  return listed.tasks.length && ['succeeded', 'failed', 'blocked', 'cancelled', 'undone'].includes(task.state) ? {task, listed} : null;
}

function fixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/swufe/extraction.json', import.meta.url), 'utf8'));
}

function withContacts(raw) {
  const contacts = {contact: '张老师', phone: '13800138000', email: 'job@swufe.edu.cn', wechat: 'swufe-job', idcard: '510100199001011234'};
  return {
    ...raw,
    events: raw.events.map(event => ({...event, contacts: {...contacts}})),
    projects: raw.projects.map(project => ({...project, contactName: '李经理', phone: '13900139000', email: 'hr@example.com'}))
  };
}

// 假浏览器读取器：不启动真实浏览器、不联网；只按契约写两张截图并记录两次页面读取。
function fakeReader({delayMs = 0, blocked = null} = {}) {
  const calls = [];
  const reader = async ({source, evidenceDir}) => {
    calls.push({kind: 'list', url: source.listUrl});
    if (blocked) throw new SourceCheckBlockedError(blocked);
    if (delayMs) await wait(delayMs);
    calls.push({kind: 'detail', url: DETAIL_URL});
    await mkdir(evidenceDir, {recursive: true});
    const at = new Date().toISOString();
    await writeFile(join(evidenceDir, '01-list.png'), PNG);
    await writeFile(join(evidenceDir, '02-detail.png'), PNG);
    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: join(evidenceDir, '01-list.png'), url: source.listUrl, title: '双选会列表', at, viewport: {width: 1366, height: 900}},
        {id: 'detail', kind: 'screenshot', file: join(evidenceDir, '02-detail.png'), url: DETAIL_URL, title: '西南财经大学2026届秋季双选会', at, viewport: {width: 1366, height: 900}}
      ]
    };
  };
  reader.calls = calls;
  return reader;
}

function fakeExtractor({raw = null} = {}) {
  const calls = [];
  const extractor = async ({screenshots}) => {
    calls.push({screenshots: screenshots.map(shot => shot.id)});
    return raw || withContacts(fixture());
  };
  extractor.calls = calls;
  return extractor;
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, keys); return keys; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); collectKeys(item, keys); }
  }
  return keys;
}

function assertNoContacts(value, label) {
  const text = JSON.stringify(value);
  for (const needle of ['13800138000', '13900139000', 'job@swufe.edu.cn', 'hr@example.com', 'swufe-job', '510100199001011234', '张老师', '李经理', 'contactName']) {
    assert.ok(!text.includes(needle), label + ' 不能包含联系方式：' + needle);
  }
  const keys = collectKeys(value).map(key => key.toLowerCase());
  for (const key of ['contact', 'contacts', 'phone', 'mobile', 'email', 'wechat', 'idcard']) {
    assert.ok(!keys.includes(key), label + ' 不能包含联系字段：' + key);
  }
}

function withStore(app, user, fn) {
  const store = RecruitStore.open(join(app.dataDir, 'users', user.id, '.data', 'recruit.db'));
  try { return fn(store); } finally { store.close(); }
}

test('来源校对：浏览器读两页 + 视觉抽取 + 只写 events/event_projects + 审计 1:1 + 幂等重试', {timeout: 60000}, async t => {
  const reader = fakeReader();
  const extractor = fakeExtractor();
  const app = await startApp(t, {browserReader: reader, extractor});
  const user = await register(app, 'source-check-user');

  const started = await postJson(app, '/api/source-check/start', user.cookie, {sourceId: 'swufe'});
  assert.equal(started.ok, true);
  assert.equal(started.sourceId, 'swufe-xjh', 'swufe 别名归一到真实来源 id');
  assert.match(started.sessionId, /^[a-f0-9-]{36}$/);
  assert.match(started.taskId, /^[a-f0-9-]{36}$/);
  assert.match(started.reason, /采集器.*禁用/);
  assert.match(started.title, /来源校对/);

  const session = await getJson(app, '/api/session/' + started.sessionId, user.cookie);
  assert.match(session.title, /来源校对/);

  const finished = await waitFor(() => taskState(app, user.cookie));
  assert.equal(finished.task.state, 'succeeded', '任务卡成功：' + JSON.stringify(finished.task.error));
  assert.equal(finished.task.counts.batches, 1);
  assert.equal(finished.task.counts.writes, 4, '1 场活动 + 3 个招聘项目');
  assert.equal(finished.task.counts.evidence, 4, '说明 + 2 张截图 + 抽取 JSON');

  // 浏览器只打开列表与一场详情各一次，没有翻页/并发。
  assert.deepEqual(reader.calls.map(call => call.kind), ['list', 'detail']);
  assert.equal(reader.calls.length, 2);
  assert.equal(extractor.calls.length, 1);
  assert.deepEqual(extractor.calls[0].screenshots, ['list', 'detail'], '视觉抽取只看两张截图');

  // 启动参数：不启用 stealth、不伪装 UA。
  assert.equal(BROWSER_LAUNCH_OPTIONS.channel, 'msedge');
  assert.equal(BROWSER_LAUNCH_OPTIONS.headless, true);
  assert.ok(!('args' in BROWSER_LAUNCH_OPTIONS), '不能带反检测/stealth 启动参数');
  assert.ok(!('userAgent' in BROWSER_CONTEXT_OPTIONS), '不能伪装 UA');
  assert.equal(BROWSER_CONTEXT_OPTIONS.viewport.width, 1366);

  const evidenceDir = join(app.dataDir, 'users', user.user.id, 'tasks', started.taskId, 'evidence');
  const files = (await readdir(evidenceDir)).sort();
  assert.deepEqual(files, ['01-list.png', '02-detail.png', 'extraction.json', 'screenshots.json']);
  for (const file of ['01-list.png', '02-detail.png']) {
    assert.ok((await readFile(join(evidenceDir, file))).length > 0, file + ' 必须落盘');
  }
  const shots = JSON.parse(await readFile(join(evidenceDir, 'screenshots.json'), 'utf8'));
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map(shot => shot.url), [resolveSource('swufe').listUrl, DETAIL_URL]);
  for (const shot of shots) {
    assert.ok(shot.title);
    assert.ok(Number.isFinite(Date.parse(shot.at)));
    assert.deepEqual(shot.viewport, {width: 1366, height: 900});
  }
  const extraction = JSON.parse(await readFile(join(evidenceDir, 'extraction.json'), 'utf8'));
  assert.equal(extraction.events.length, 1);
  assert.equal(extraction.projects.length, 3);
  assertNoContacts(extraction, '抽取证据');
  assert.equal(extraction.events[0].endAt, '', '读不到的字段留空');
  assert.equal(extraction.projects[0].requirements, '');

  // 任务卡证据：2 张截图 + 抽取 JSON，截图可通过本人证据接口取回。
  const evidence = finished.task.evidence;
  assert.equal(evidence.filter(item => item.kind === 'screenshot').length, 2);
  assert.equal(evidence.filter(item => item.kind === 'extraction').length, 1);
  const screenshotEvidence = evidence.filter(item => item.kind === 'screenshot');
  for (const item of screenshotEvidence) {
    assert.match(item.url, /^\/api\/source-check\/evidence\?taskId=/);
    const response = await fetch(app.origin + item.url, {headers: {'x-career-token': app.token, cookie: user.cookie}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  }

  // 只写 events / event_projects；source_id=manual、source_url 只记录、notes 标明非采集器。
  const rows = withStore(app, user.user, store => ({
    events: store.db.prepare('SELECT * FROM events').all(),
    projects: store.db.prepare('SELECT * FROM event_projects').all(),
    audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all(),
    runs: store.db.prepare('SELECT COUNT(*) c FROM runs').get().c,
    rawPages: store.db.prepare('SELECT COUNT(*) c FROM raw_pages').get().c,
    idem: store.db.prepare('SELECT * FROM idempotency').all()
  }));
  assert.equal(rows.events.length, 1);
  assert.equal(rows.projects.length, 3);
  assert.equal(rows.events[0].source_id, 'manual');
  assert.equal(rows.events[0].source_url, DETAIL_URL);
  assert.match(rows.events[0].notes, /浏览器截图读取（非采集器）/);
  for (const project of rows.projects) {
    assert.equal(project.source_id, 'manual');
    assert.match(project.notes, /浏览器截图读取（非采集器）/);
  }
  assert.equal(rows.runs, 0, '不调用采集器，不产生采集运行记录');
  assert.equal(rows.rawPages, 0, '不抓取原始页面');
  assert.ok(!existsSync(join(app.dataDir, 'users', user.user.id, '.data', 'company.db')), '不写公司档案库');

  // 审计：数据行 1:1，同批次，actor_type=model_api，source_ref 指向截图。
  assert.equal(rows.audits.length, 4);
  assert.equal(new Set(rows.audits.map(row => row.batch_id)).size, 1);
  assert.ok(rows.audits.every(row => row.task_id === started.taskId));
  assert.ok(rows.audits.every(row => row.actor_type === 'model_api'));
  assert.ok(rows.audits.every(row => row.entity === 'events' || row.entity === 'event_projects'));
  assert.ok(rows.audits.every(row => row.source_ref === 'artifact:02-detail.png'));
  assert.ok(rows.audits.every(row => row.confirmed === 0));
  assert.equal(rows.idem.length, 1);
  assert.equal(rows.idem[0].status, 'completed');
  assert.equal(rows.idem[0].key, 'source-check:' + started.taskId + ':write');
  for (const row of rows.audits) {
    assertNoContacts(JSON.parse(row.new_values), '审计新值');
    assert.equal(row.old_values, null);
  }

  // 来源卡：最近手动读取 + 原因；不改成已接入，也没有采集器 last_run。
  const sources = await getJson(app, '/api/recruit/sources', user.cookie);
  const swufe = sources.sources.find(source => source.id === 'swufe-xjh');
  assert.equal(swufe.enabled, 0);
  assert.equal(swufe.last_status, null);
  assert.equal(sources.manualReads['swufe-xjh'].status, 'succeeded');
  assert.match(sources.manualReads['swufe-xjh'].reason, /采集器.*禁用/);
  assert.ok(Number.isFinite(Date.parse(sources.manualReads['swufe-xjh'].at)));
  // 采集器的 last_run 语义保持为空，手动读取单独记在 source_manual_reads。
  const sourceRow = withStore(app, user.user, store => store.db.prepare("SELECT * FROM sources WHERE id='swufe-xjh'").get());
  assert.equal(sourceRow.last_run, null, '来源卡不写采集器 last_run 语义');

  // 幂等重试：同一个任务 + 同一抽取结果重放，不新增行、不新增审计，只标 duplicate。
  const source = {...resolveSource('swufe-xjh'), detailUrl: DETAIL_URL};
  const replay = await writeSourceCheck({
    dataDir: app.dataDir,
    userId: user.user.id,
    taskId: started.taskId,
    extraction,
    source,
    screenshots: shots
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.duplicate, true);
  const afterReplay = withStore(app, user.user, store => ({
    events: store.db.prepare('SELECT COUNT(*) c FROM events').get().c,
    projects: store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c,
    audits: store.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c
  }));
  assert.deepEqual(afterReplay, {events: 1, projects: 3, audits: 4});
  assert.equal(SOURCE_CHECK_NOTES, '浏览器截图读取（非采集器）');
});

test('来源校对：登录/验证码/阻断时任务标 blocked + 原因 + 恢复建议，用户可取消', {timeout: 60000}, async t => {
  const reader = fakeReader({blocked: {code: 'SOURCE_BLOCKED', reason: '页面出现验证码，无法继续读取。', recovery: '改用公众号文章转发或手动导入；不要绕过验证。'}});
  const app = await startApp(t, {browserReader: reader, extractor: fakeExtractor()});
  const user = await register(app, 'blocked-user');

  const started = await postJson(app, '/api/source-check/start', user.cookie, {sourceId: 'swufe-xjh'});
  const finished = await waitFor(() => taskState(app, user.cookie));
  assert.equal(finished.task.state, 'blocked');
  assert.equal(finished.task.error.code, 'SOURCE_BLOCKED');
  assert.match(finished.task.error.message, /验证码/);
  assert.match(finished.task.error.recovery, /公众号|手动导入/);
  assert.match(finished.task.phase, /验证码/);
  assert.equal(finished.listed.badge, 0, 'blocked 不占顶栏徽标');
  assert.equal(finished.listed.counts.blocked, 1);

  // 阻断时不写库、不产生抽取证据。
  const evidenceDir = join(app.dataDir, 'users', user.user.id, 'tasks', started.taskId, 'evidence');
  if (existsSync(evidenceDir)) {
    const files = await readdir(evidenceDir);
    assert.ok(!files.includes('extraction.json'));
  }
  const rows = withStore(app, user.user, store => ({
    events: store.db.prepare('SELECT COUNT(*) c FROM events').get().c,
    audits: store.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='write_audit'").get().c === 0
      ? 0 : store.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c
  }));
  assert.deepEqual(rows, {events: 0, audits: 0});

  const sources = await getJson(app, '/api/recruit/sources', user.cookie);
  assert.equal(sources.manualReads['swufe-xjh'].status, 'blocked');

  // 用户可取消：blocked 是活动态，不在终态里。
  const stopped = await postJson(app, '/api/tasks/stop', user.cookie, {taskId: started.taskId});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.task.state, 'cancelled');
  const after = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(after.tasks[0].state, 'cancelled');
});


test('参会企业页签：找到并点击/滚动；swufe 必需时失败会抛错', async () => {
  const calls = [];
  const page = (count, fail = false) => ({
    getByText: () => ({first: () => ({
      count: async () => count,
      click: async () => { calls.push('click'); if (fail) throw new Error('click failed'); }
    })}),
    waitForTimeout: async () => {},
    evaluate: async () => { calls.push('scroll'); }
  });
  assert.equal(await openParticipantTab(page(1), {required: true}), true);
  assert.deepEqual(calls, ['click', 'scroll']);
  assert.equal(await openParticipantTab(page(0), {required: false}), false);
  await assert.rejects(() => openParticipantTab(page(0), {required: true}), /参会企业/);
  await assert.rejects(() => openParticipantTab(page(1, true), {required: true}), /参会企业|点击/);
});


test('抽取规范化：详情 URL 只给标题匹配的一场，其余留空', () => {
  const raw = {
    events: [
      {title: '西南财经大学2026年秋季大型双选会', startAt: '2026-10-27T14:00:00+08:00'},
      {title: '西南财经大学第八届律所专场校园招聘会', startAt: '2026-05-12T14:00:00+08:00'},
      {title: '西南财经大学“校招市集”2026年秋季系列双选会（第一场）', startAt: '2026-09-29T14:00:00+08:00'}
    ],
    projects: []
  };
  const withTitle = normalizeExtraction(raw, {
    source: {id: 'swufe-xjh'},
    detailUrl: DETAIL_URL,
    detailTitle: '西南财经大学2026年秋季大型双选会-现场双选会-西财智慧就业系统'
  });
  assert.equal(withTitle.events[0].sourceUrl, DETAIL_URL, '只有与详情标题匹配的那一场拿到详情 URL');
  assert.equal(withTitle.events[1].sourceUrl, '', '其余活动不继承 event-0 的详情 URL');
  assert.equal(withTitle.events[2].sourceUrl, '', '其余活动不继承 event-0 的详情 URL');

  const withoutTitle = normalizeExtraction(raw, {source: {id: 'swufe-xjh'}, detailUrl: DETAIL_URL});
  assert.deepEqual(withoutTitle.events.map(event => event.sourceUrl), ['', '', ''], '没有详情标题时不能猜 URL');
});

test('阻断识别与联系方式清洗：登录跳转/验证码停下，联系方式递归丢弃', () => {
  const normal = detectBlock({url: 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm', title: '西南财经大学就业信息网', text: '2026届秋季双选会'});
  assert.equal(normal.blocked, false);
  const login = detectBlock({url: 'https://job3.swufe.edu.cn/login?redirect=/jobfair', title: '登录', text: ''});
  assert.equal(login.blocked, true);
  assert.equal(login.code, 'SOURCE_LOGIN_REQUIRED');
  assert.ok(login.recovery);
  const captcha = detectBlock({url: 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm', title: '安全验证', text: '请输入验证码后继续'});
  assert.equal(captcha.blocked, true);
  assert.equal(captcha.code, 'SOURCE_BLOCKED');

  const cleaned = stripContacts({title: '活动', contacts: {phone: '13800138000'}, nested: {email: 'a@b.com', keep: 'ok'}, note: '13800138000'});
  assert.deepEqual(cleaned, {title: '活动', nested: {keep: 'ok'}, note: ''});
});
