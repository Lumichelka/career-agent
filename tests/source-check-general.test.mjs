import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync, readFileSync} from 'node:fs';
import {createApp} from '../src/server/app.mjs';
import {readFeed} from '../src/recruit/feed.mjs';
import {callTool} from '../src/tools/execute.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {resolveSource, resolveSourceCheckTarget, SOURCE_CHECK_NOTES} from '../src/source-check/pipeline.mjs';
import {normalizeSourceCheckUrl, sourceCheckEnabled, sourceCheckConfig, selectDetailHref} from '../src/source-check/config.mjs';
import {buildExtractionPrompt, normalizeExtraction} from '../src/source-check/extract.mjs';
import {operatorProfileDir} from '../src/config/paths.mjs';
import {checkOperatorUrl, classifyDangerousAction, actionScreenshotName, OPERATOR_MAX_ACTIVE_MS, OPERATOR_STEP_LOG_THRESHOLD, executeOperatorPlan, OPERATOR_LAUNCH_OPTIONS, normalizeOperatorSteps, forbiddenTerms} from '../src/source-check/operator.mjs';
import {SourceCheckBlockedError} from '../src/source-check/browser.mjs';
import {listPlaybooks, loadPlaybook, playbookForSource, playbookSteps} from '../src/source-check/playbook.mjs';

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

// ---- operator 核心 ----

test('operator profile：每个用户一个持久目录，放在 users/<id>/profile', () => {
  const dir = operatorProfileDir('/data', 'user-a');
  assert.equal(dir, join('/data', 'users', 'user-a', 'profile'));
  assert.equal(operatorProfileDir('/data', 'user-a'), operatorProfileDir('/data', 'user-a'), '同一用户稳定复用');
  assert.notEqual(operatorProfileDir('/data', 'user-a'), operatorProfileDir('/data', 'user-b'));
  assert.throws(() => operatorProfileDir('/data', '../escape'), /无效的用户身份/);
  assert.equal(OPERATOR_MAX_ACTIVE_MS, 10 * 60 * 1000, '单次操作硬上限 10 分钟');
});

test('operator URL 策略：只允许 http/https，拒绝特殊 scheme 与字面私网', () => {
  assert.equal(checkOperatorUrl('https://career.uibe.edu.cn/zhaopin/').ok, true);
  assert.equal(checkOperatorUrl('https://career.uibe.edu.cn/zhaopin/').url, 'https://career.uibe.edu.cn/zhaopin/');
  assert.equal(checkOperatorUrl('http://job3.swufe.edu.cn/list').ok, true);
  for (const url of [
    'file:///C:/Windows/win.ini',
    'chrome://settings',
    'edge://version',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,hi',
    'blob:https://x/abc',
    'view-source:https://x/',
    'ftp://career.uibe.edu.cn/'
  ]) {
    const out = checkOperatorUrl(url);
    assert.equal(out.ok, false, url + ' 必须拒绝');
    assert.equal(out.code, 'OPERATOR_URL_BLOCKED');
  }
  for (const url of ['http://127.0.0.1:4189/', 'http://localhost:3000/', 'http://10.0.0.5/', 'http://192.168.1.10/', 'http://169.254.169.254/', 'http://[::1]/']) {
    assert.equal(checkOperatorUrl(url).ok, false, url + ' 私网必须拒绝');
  }
  assert.equal(checkOperatorUrl('https://career.uibe.edu.cn/').ok, true, '公网不受影响');
});

test('operator 危险动作：投递/支付/删除/退出/提交表单命中硬确认，普通点击不命中', () => {
  const cases = [
    [{action: 'click', target: '#apply', text: '投递简历'}, 'apply'],
    [{action: 'click', target: '#buy', text: '立即支付'}, 'payment'],
    [{action: 'click', target: '#del', text: '删除这条记录'}, 'delete'],
    [{action: 'click', target: '#logout', text: '退出登录'}, 'logout'],
    [{action: 'submit', target: 'form#job', text: '提交表单'}, 'submit'],
    [{action: 'click', target: '#send', text: '提交'}, 'submit']
  ];
  for (const [step, kind] of cases) {
    const out = classifyDangerousAction(step);
    assert.equal(out.dangerous, true, JSON.stringify(step) + ' 应命中硬确认');
    assert.equal(out.kind, kind);
    assert.ok(out.reason);
  }
  for (const step of [
    {action: 'click', target: '#next', text: '下一页'},
    {action: 'goto', url: 'https://career.uibe.edu.cn/list'},
    {action: 'fill', target: '#q', value: '招聘'},
    {action: 'evaluate', script: 'document.title'}
  ]) {
    assert.equal(classifyDangerousAction(step).dangerous, false, JSON.stringify(step) + ' 不应误报');
  }

  // playbook.forbiddenActions 与 DANGER_PATTERNS 合并：短语按顿号/逗号切词后做文本匹配。
  const pb = ['投递、报名、支付、删除、退出登录', '提交任何表单（除非用户确认）', '关注公众号、修改账号设置'];
  assert.ok(forbiddenTerms(pb).includes('报名'));
  assert.ok(!forbiddenTerms(pb).includes('访问'), '不把单个泛词切出来');
  const byPlaybook = classifyDangerousAction({action: 'click', target: '#follow', text: '关注公众号'}, {forbiddenActions: pb});
  assert.equal(byPlaybook.dangerous, true);
  assert.equal(byPlaybook.kind, 'forbidden');
  assert.match(byPlaybook.reason, /关注公众号/);
  assert.equal(classifyDangerousAction({action: 'click', target: '#next', text: '下一页'}, {forbiddenActions: pb}).dangerous, false, '普通点击不因 playbook 误报');
});

test('operator 不设步数硬上限（ADR 0001）：超过 200 步仍可归一化，仅保留安全日志阈值', () => {
  const steps = Array.from({length: 250}, () => ({action: 'wait', ms: 0}));
  const out = normalizeOperatorSteps(steps, {source: {}});
  assert.equal(out.length, 250);
  assert.ok(OPERATOR_STEP_LOG_THRESHOLD >= 200);
});

test('operator 每步截图文件名稳定：action-001.png 起，按步号补零', () => {
  assert.equal(actionScreenshotName(1), 'action-001.png');
  assert.equal(actionScreenshotName(42), 'action-042.png');
  assert.match(actionScreenshotName(1), /^action-\d{3}\.png$/);
});


function fakeOperatorPage({loginAfterGoto = false, title = '招聘列表', text = '双选会列表', onAfter = {}} = {}) {
  const calls = [];
  const handlers = new Map();
  let currentUrl = 'https://career.example.edu.cn/list';
  const page = {
    calls,
    handlers,
    url: () => currentUrl,
    setUrl: value => { currentUrl = String(value); },
    title: async () => (loginAfterGoto && currentUrl.includes('/login') ? '登录' : title),
    goto: async url => {
      calls.push({action: 'goto', url});
      currentUrl = loginAfterGoto ? 'https://career.example.edu.cn/login?redirect=/list' : url;
      return null;
    },
    click: async selector => {
      calls.push({action: 'click', selector});
      if (onAfter[selector]) await onAfter[selector](page);
    },
    fill: async (selector, value) => { calls.push({action: 'fill', selector, value}); },
    press: async (selector, key) => { calls.push({action: 'press', selector, key}); },
    evaluate: async script => {
      // detectOperatorPause 用函数读取页面文本，不算计划里的一步。
      if (typeof script !== 'function') calls.push({action: 'evaluate', script});
      return text;
    },
    screenshot: async ({path}) => { calls.push({action: 'screenshot', path}); await writeFile(path, PNG); },
    waitForTimeout: async ms => { calls.push({action: 'wait', ms}); await wait(ms); },
    on: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); return page; },
    emit: async (name, value) => { for (const handler of handlers.get(name) || []) await handler(value); }
  };
  return page;
}

function fakeOperatorLauncher(page, capture) {
  const context = {
    pages: () => [page],
    newPage: async () => page,
    route: async () => {},
    on: () => {},
    close: async () => { capture.closed = true; }
  };
  const launch = async options => {
    capture.options = options;
    return context;
  };
  return launch;
}

test('operator 执行：persistent profile + 可见窗口 + 每步 action.jsonl/截图/证据', {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-operator-run-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const page = fakeOperatorPage();
  const capture = {};
  const events = [];
  const evidence = [];
  const phases = [];
  const evidenceDir = join(dir, 'evidence');
  const out = await executeOperatorPlan({
    profileDir: operatorProfileDir(dir, 'user-a'),
    evidenceDir,
    taskId: '11111111-1111-4111-8111-111111111111',
    steps: [
      {action: 'goto', url: 'https://career.example.edu.cn/list'},
      {action: 'evaluate', script: 'document.title'},
      {action: 'screenshot', label: '列表页'}
    ],
    launch: fakeOperatorLauncher(page, capture),
    emit: event => events.push(event),
    addEvidence: entry => evidence.push(entry),
    setPhase: text => phases.push(text),
    askHuman: async () => { throw new Error('普通步骤不应触发人工接管'); }
  });

  assert.equal(out.ok, true);
  assert.equal(capture.closed, true, '任务收尾必须关闭浏览器上下文');
  assert.equal(capture.options.profileDir, operatorProfileDir(dir, 'user-a'));
  assert.equal(capture.options.options.headless, false, '必须可见窗口登录');
  assert.equal(capture.options.options.acceptDownloads, false, '禁止下载');
  assert.deepEqual(capture.options.options.permissions, ['clipboard-read', 'clipboard-write'], '允许剪贴板');
  assert.equal(OPERATOR_LAUNCH_OPTIONS.headless, false);

  const log = (await readFile(join(evidenceDir, 'action.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.length, 3, '每步一条动作记录');
  assert.deepEqual(log.map(item => item.step), [1, 2, 3]);
  assert.deepEqual(log.map(item => item.action), ['goto', 'evaluate', 'screenshot']);
  for (const item of log) {
    for (const key of ['step', 'action', 'target', 'url', 'startedAt', 'durationMs', 'result', 'screenshotRef']) {
      assert.ok(Object.hasOwn(item, key), 'action.jsonl 缺字段：' + key);
    }
    assert.equal(item.result, 'ok');
    assert.match(item.screenshotRef, /^action-\d{3}\.png$/);
    assert.ok(Number.isFinite(Date.parse(item.startedAt)));
    assert.ok(Number.isFinite(item.durationMs));
    assert.equal(item.url, 'https://career.example.edu.cn/list');
  }
  const files = (await readdir(evidenceDir)).sort();
  assert.deepEqual(files, ['action-001.png', 'action-002.png', 'action-003.png', 'action.jsonl']);
  for (let step = 1; step <= 3; step += 1) {
    assert.ok((await readFile(join(evidenceDir, actionScreenshotName(step)))).length > 0, '每步截图必须落盘');
  }
  assert.equal(evidence.length, 3, '每步都要进任务证据');
  assert.match(evidence[0].url, /^\/api\/source-check\/evidence\?taskId=/);
  assert.equal(events.filter(event => event.type === 'operator_action').length, 3);
  assert.ok(phases.some(text => /步骤 1/.test(text)));
});

test('operator 人工接管：登录页暂停 waiting_login，处理后续跑且不重跑停点前的步骤', {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-operator-login-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const page = fakeOperatorPage({loginAfterGoto: true});
  const capture = {};
  const human = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = executeOperatorPlan({
    profileDir: operatorProfileDir(dir, 'user-a'),
    evidenceDir: join(dir, 'evidence'),
    taskId: '22222222-2222-4222-8222-222222222222',
    steps: [
      {action: 'goto', url: 'https://career.example.edu.cn/list'},
      {action: 'evaluate', script: 'document.title'},
      {action: 'screenshot', label: '登录后的列表'}
    ],
    launch: fakeOperatorLauncher(page, capture),
    emit: () => {},
    addEvidence: async () => {},
    askHuman: async info => { human.push(info); await gate; return {action: 'resume'}; }
  });

  await waitFor(() => human.length > 0);
  assert.equal(human[0].state, 'waiting_login');
  assert.equal(human[0].kind, 'login');
  assert.match(human[0].reason, /登录/);
  assert.equal(page.calls.filter(call => call.action === 'goto').length, 1);
  assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 0, '暂停期间不能继续后续步骤');
  page.setUrl('https://career.example.edu.cn/list');
  release();
  const out = await running;
  assert.equal(out.ok, true);
  assert.equal(page.calls.filter(call => call.action === 'goto').length, 1, '续跑不重跑已完成的步骤');
  assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 1);
  const log = (await readFile(join(dir, 'evidence', 'action.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.length, 3);
  assert.equal(log[0].result, 'paused');
  assert.match(log[0].reason, /登录/);
  assert.equal(log[1].result, 'ok');
});

test('operator 硬确认：投递命中等你确认；拒绝不点击，接受才点击', {timeout: 30000}, async t => {
  for (const decision of ['reject', 'accept']) {
    const dir = await mkdtemp(join(tmpdir(), 'zx-operator-confirm-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const page = fakeOperatorPage();
    const human = [];
    const out = await executeOperatorPlan({
      profileDir: operatorProfileDir(dir, 'user-a'),
      evidenceDir: join(dir, 'evidence'),
      taskId: '33333333-3333-4333-8333-333333333333',
      steps: [
        {action: 'click', target: '#apply', text: '投递简历'},
        {action: 'evaluate', script: 'document.title'}
      ],
      launch: fakeOperatorLauncher(page, {}),
      emit: () => {},
      addEvidence: async () => {},
      askHuman: async info => { human.push(info); return {action: 'resume', decision}; }
    });
    assert.equal(out.ok, true);
    assert.equal(human.length, 1);
    assert.equal(human[0].state, 'waiting_confirmation');
    assert.equal(human[0].confirmKind, 'apply');
    assert.match(human[0].reason, /投递|确认/);
    const clickCalls = page.calls.filter(call => call.action === 'click');
    if (decision === 'reject') {
      assert.equal(clickCalls.length, 0, '拒绝后不能执行危险点击');
      const log = (await readFile(join(dir, 'evidence', 'action.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(log[0].result, 'rejected');
    } else {
      assert.equal(clickCalls.length, 1, '接受后才执行危险点击');
    }
    assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 1, '确认后继续执行计划');
  }
});

test('operator 时间上限：总活跃时间到上限后暂停；继续不重置额度，剩余步骤不再执行', {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-operator-timeout-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const page = fakeOperatorPage();
  const human = [];
  await assert.rejects(executeOperatorPlan({
    profileDir: operatorProfileDir(dir, 'user-a'),
    evidenceDir: join(dir, 'evidence'),
    taskId: '44444444-4444-4444-8444-444444444444',
    maxActiveMs: 40,
    steps: [
      {action: 'wait', ms: 80},
      {action: 'evaluate', script: 'document.title'}
    ],
    launch: fakeOperatorLauncher(page, {}),
    emit: () => {},
    addEvidence: async () => {},
    askHuman: async info => { human.push(info); return {action: 'resume'}; }
  }), error => error?.code === 'OPERATOR_ACTIVE_LIMIT');
  assert.equal(human.length, 1, '到上限只暂停一次，然后失败关闭');
  assert.equal(human[0].state, 'waiting_human');
  assert.equal(human[0].kind, 'timeout');
  assert.match(human[0].reason, /上限/);
  assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 0, '总活跃额度耗尽后不能再执行剩余步骤');
});

test('operator 禁止下载/上传：命中即暂停，人工处理后跳过该步并留证据', {timeout: 30000}, async t => {
  for (const [selector, eventName, kind] of [['#upload', 'filechooser', 'upload'], ['#download', 'download', 'download']]) {
    const dir = await mkdtemp(join(tmpdir(), 'zx-operator-policy-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const page = fakeOperatorPage({
      onAfter: {
        [selector]: async target => target.emit(eventName, eventName === 'download'
          ? {suggestedFilename: () => 'x.pdf', cancel: async () => {}}
          : {setFiles: async () => {}})
      }
    });
    const human = [];
    const out = await executeOperatorPlan({
      profileDir: operatorProfileDir(dir, 'user-a'),
      evidenceDir: join(dir, 'evidence'),
      taskId: '55555555-5555-4555-8555-555555555555',
      steps: [{action: 'click', target: selector, text: '普通按钮'}, {action: 'evaluate', script: 'document.title'}],
      launch: fakeOperatorLauncher(page, {}),
      emit: () => {},
      addEvidence: async () => {},
      askHuman: async info => { human.push(info); return {action: 'resume'}; }
    });
    assert.equal(out.ok, true);
    assert.equal(human.length, 1, selector + ' 应触发一次人工接管');
    assert.equal(human[0].state, 'waiting_human');
    assert.equal(human[0].kind, 'policy');
    assert.match(human[0].reason, new RegExp(kind === 'upload' ? '上传' : '下载'));
    const log = (await readFile(join(dir, 'evidence', 'action.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log[0].result, 'blocked');
    assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 1);
  }
});

test('operator 任意 Playwright：程序内注入的步骤可以直接拿 page 执行', {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-operator-playwright-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const page = fakeOperatorPage();
  const out = await executeOperatorPlan({
    profileDir: operatorProfileDir(dir, 'user-a'),
    evidenceDir: join(dir, 'evidence'),
    taskId: '66666666-6666-4666-8666-666666666666',
    steps: [{action: 'playwright', label: '自定义 Playwright', perform: async ({page: target}) => { await target.click('#custom'); }}],
    launch: fakeOperatorLauncher(page, {}),
    emit: () => {},
    addEvidence: async () => {},
    askHuman: async () => { throw new Error('普通自定义步骤不应暂停'); }
  });
  assert.equal(out.ok, true);
  assert.deepEqual(page.calls.filter(call => call.action === 'click'), [{action: 'click', selector: '#custom'}]);
  const log = (await readFile(join(dir, 'evidence', 'action.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log[0].action, 'playwright');
  assert.equal(log[0].result, 'ok');
});

// ---- operator HTTP 任务 ----

test('operator HTTP：AI 采集打开可见 profile，登录暂停后点继续从停点续跑，动作/截图可取证', {timeout: 60000}, async t => {
  const page = fakeOperatorPage({loginAfterGoto: true});
  const capture = {};
  const app = await startApp(t, {operator: {launch: fakeOperatorLauncher(page, capture)}});
  const user = await register(app, 'operator-http-user');
  const listUrl = 'https://mp.weixin.qq.com/s/example';
  const loginUrl = 'https://mp.weixin.qq.com/login';

  const started = await postJson(app, '/api/source-check/operator/start', user.cookie, {url: listUrl, confirm: true});
  assert.equal(started.ok, true);
  assert.match(started.taskId, /^[a-f0-9-]{36}$/);
  assert.match(started.sessionId, /^[a-f0-9-]{36}$/);
  assert.match(started.title, /来源操作/);
  assert.equal(started.mode, 'operator');

  const waiting = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    return listed.tasks[0]?.state === 'waiting_login' ? listed : null;
  });
  assert.equal(waiting.badge, 1, '等待登录要计入顶栏徽标');
  const task = waiting.tasks[0];
  assert.equal(task.operator.waiting.kind, 'login');
  assert.match(task.operator.waiting.reason, /登录/);
  assert.equal(task.operator.actions.length, 1);
  assert.equal(task.operator.actions[0].result, 'paused');
  assert.equal(task.operator.actions[0].action, 'goto');
  assert.equal(task.operator.actions[0].screenshotRef, 'action-001.png');

  // profile 是应用自己的 per-user 持久目录，启动参数可见、禁下载、允许剪贴板。
  const profileDir = join(app.dataDir, 'users', user.user.id, 'profile');
  assert.equal(capture.options.profileDir, profileDir);
  assert.ok(existsSync(profileDir), 'persistent profile 目录必须存在');
  assert.equal(capture.options.options.headless, false);
  assert.equal(capture.options.options.acceptDownloads, false);
  assert.deepEqual(capture.options.options.permissions, ['clipboard-read', 'clipboard-write']);

  // 动作日志与每步截图走任务证据接口，只对本人开放。
  const logResponse = await fetch(app.origin + '/api/source-check/evidence?taskId=' + task.id + '&file=action.jsonl', {headers: {'x-career-token': app.token, cookie: user.cookie}});
  assert.equal(logResponse.status, 200);
  assert.match(logResponse.headers.get('content-type'), /application\/json/);
  const log = (await logResponse.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.length, 1);
  assert.equal(log[0].step, 1);
  for (const key of ['step', 'action', 'target', 'url', 'startedAt', 'durationMs', 'result', 'screenshotRef']) assert.ok(Object.hasOwn(log[0], key));
  const shotResponse = await fetch(app.origin + '/api/source-check/evidence?taskId=' + task.id + '&file=action-001.png', {headers: {'x-career-token': app.token, cookie: user.cookie}});
  assert.equal(shotResponse.status, 200);
  assert.equal(shotResponse.headers.get('content-type'), 'image/png');

  // 用户点「已登录，继续」：不重跑第 1 步，从停点继续到计划完成。
  page.setUrl(listUrl);
  const resumed = await postJson(app, '/api/source-check/operator/continue', user.cookie, {taskId: task.id});
  assert.equal(resumed.ok, true);
  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    return listed.tasks[0]?.state === 'succeeded' ? listed.tasks[0] : null;
  });
  assert.equal(finished.operator.state, 'succeeded');
  assert.equal(finished.operator.actions.length, 2);
  assert.deepEqual(finished.operator.actions.map(item => item.action), ['goto', 'screenshot']);
  assert.equal(page.calls.filter(call => call.action === 'goto').length, 1, '续跑不重跑登录前的步骤');
  assert.equal(capture.closed, true, '任务完成后关闭浏览器上下文');
  assert.equal((await getJson(app, '/api/tasks', user.cookie)).badge, 0);
});

test('operator HTTP：危险动作硬确认可拒绝/接受；等待中可停止任务', {timeout: 60000}, async t => {
  const page = fakeOperatorPage();
  const capture = {};
  const app = await startApp(t, {operator: {launch: fakeOperatorLauncher(page, capture)}});
  const user = await register(app, 'operator-confirm-user');

  // HTTP 不再接受客户端 steps；危险动作场景走进程内注入（服务端/测试），继续/确认仍走 HTTP。
  const started = await app.operator.start({
    user: user.user,
    url: 'https://career.uibe.edu.cn/zhaopin/',
    confirm: true,
    steps: [
      {action: 'click', target: '#apply', text: '投递简历'},
      {action: 'evaluate', script: 'document.title'}
    ]
  });
  assert.equal(started.status, 200);
  const pending = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    const task = listed.tasks.find(item => item.id === started.json.taskId);
    return task?.state === 'waiting_confirmation' ? task : null;
  });
  assert.equal(pending.operator.waiting.kind, 'confirm');
  assert.equal(pending.operator.waiting.confirmKind, 'apply');
  assert.match(pending.operator.waiting.reason, /投递|确认/);

  await postJson(app, '/api/source-check/operator/confirm', user.cookie, {taskId: started.json.taskId, decision: 'reject'});
  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    return listed.tasks.find(item => item.id === started.json.taskId)?.state === 'succeeded' ? listed.tasks.find(item => item.id === started.json.taskId) : null;
  });
  assert.equal(page.calls.filter(call => call.action === 'click').length, 0, '拒绝后不执行危险点击');
  assert.equal(finished.operator.actions[0].result, 'rejected');
  assert.equal(page.calls.filter(call => call.action === 'evaluate').length, 1, '拒绝后继续计划');

  // 第二条任务：等待登录时停止，任务取消且浏览器关闭。
  const page2 = fakeOperatorPage({loginAfterGoto: true});
  const capture2 = {};
  const app2 = await startApp(t, {operator: {launch: fakeOperatorLauncher(page2, capture2)}});
  const user2 = await register(app2, 'operator-stop-user');
  await postJson(app2, '/api/source-check/operator/start', user2.cookie, {url: 'https://mp.weixin.qq.com/s/x', confirm: true});
  const paused = await waitFor(async () => {
    const listed = await getJson(app2, '/api/tasks', user2.cookie);
    return listed.tasks[0]?.state === 'waiting_login' ? listed.tasks[0] : null;
  });
  const stopped = await postJson(app2, '/api/tasks/stop', user2.cookie, {taskId: paused.id});
  assert.equal(stopped.ok, true);
  const cancelled = await waitFor(async () => {
    const listed = await getJson(app2, '/api/tasks', user2.cookie);
    return listed.tasks[0]?.state === 'cancelled' ? listed.tasks[0] : null;
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(capture2.closed, true, '停止后必须关闭浏览器上下文');
});

test('operator HTTP：客户端 steps/evaluate 被拒绝、未确认不启动、私网地址 400；跨用户不能续跑', {timeout: 30000}, async t => {
  const app = await startApp(t, {operator: {launch: fakeOperatorLauncher(fakeOperatorPage(), {})}});
  const user = await register(app, 'operator-invalid-user');
  const base = 'https://career.uibe.edu.cn/';

  // P0：任何 web token 持有者都不能通过 HTTP 注入步骤/JS 去驱动登录 profile。
  const clientSteps = await postJson(app, '/api/source-check/operator/start', user.cookie, {
    url: base, confirm: true, steps: [{action: 'goto', url: base}]
  }, 400);
  assert.equal(clientSteps.code, 'OPERATOR_STEPS_FORBIDDEN');
  const clientEvaluate = await postJson(app, '/api/source-check/operator/start', user.cookie, {
    url: base, confirm: true, evaluate: 'document.cookie'
  }, 400);
  assert.equal(clientEvaluate.code, 'OPERATOR_STEPS_FORBIDDEN');
  const viaStart = await postJson(app, '/api/source-check/start', user.cookie, {
    mode: 'operator', url: base, confirm: true, steps: [{action: 'goto', url: base}]
  }, 400);
  assert.equal(viaStart.code, 'OPERATOR_STEPS_FORBIDDEN', 'source-check/start 的 operator 分支同样拒绝 steps');

  // 每次 AI 采集/兜底都要一次明确确认。
  const noConfirm = await postJson(app, '/api/source-check/operator/start', user.cookie, {url: base}, 400);
  assert.equal(noConfirm.code, 'OPERATOR_CONFIRM_REQUIRED');
  const noConfirmWechat = await postJson(app, '/api/wechat/operator/start', user.cookie, {}, 400);
  assert.equal(noConfirmWechat.code, 'OPERATOR_CONFIRM_REQUIRED');

  const privateUrl = await postJson(app, '/api/source-check/operator/start', user.cookie, {url: 'http://127.0.0.1:4189/', confirm: true}, 400);
  assert.equal(privateUrl.code, 'INVALID_URL');
  const unknownAction = await app.operator.start({user: user.user, url: base, confirm: true, steps: [{action: 'drag', target: '#x'}]});
  assert.equal(unknownAction.status, 400);
  assert.equal(unknownAction.json.code, 'INVALID_OPERATOR_STEP');
  assert.equal((await getJson(app, '/api/tasks', user.cookie)).tasks.length, 0, '非法/未确认请求不产生任务');

  const other = await register(app, 'operator-other-user');
  const continueOther = await postJson(app, '/api/source-check/operator/continue', other.cookie, {taskId: '99999999-9999-4999-8999-999999999999'}, 404);
  assert.equal(continueOther.code, 'OPERATOR_NOT_WAITING');
});

test('operator HTTP：公众号 AI 采集默认西财校招，读文章写入并在 feed 查到证据', {timeout: 60000}, async t => {
  const page = fakeOperatorPage({title: '公众号文章列表', text: '西南财经大学公众号'});
  const capture = {};
  const jobfair = readFileSync(new URL('./fixtures/wechat-xicai-article.txt', import.meta.url), 'utf8');
  const articleUrl = 'https://mp.weixin.qq.com/s?__biz=MzM5MDAxMzM4MQ%3D%3D&mid=2650000009&idx=1&sn=jobfair-http';
  const readers = {
    list: async () => [{title: '西南财经大学2027届秋季双选会邀请函', url: articleUrl}],
    article: async () => ({title: '西南财经大学2027届秋季双选会邀请函', nickname: '西财校招', publishedAt: '2026-11-10', text: jobfair})
  };
  const app = await startApp(t, {operator: {launch: fakeOperatorLauncher(page, capture)}, wechatOperator: {readers}});
  const user = await register(app, 'wechat-operator-http-user');
  const started = await postJson(app, '/api/wechat/operator/start', user.cookie, {confirm: true});
  assert.equal(started.ok, true);
  assert.equal(started.mode, 'wechat_operator');
  assert.match(started.accountName, /西财校招/);
  assert.match(started.sessionId, /^[a-f0-9-]{36}$/);
  assert.match(started.taskId, /^[a-f0-9-]{36}$/);

  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    return listed.tasks.find(task => task.id === started.taskId && task.state === 'succeeded') || null;
  });
  assert.equal(finished.operator.actions.length, 4, '打开列表 + 读列表 + 打开正文 + 读正文');
  assert.equal(finished.counts.writes, 7, '1 场活动 + 6 个单位');
  assert.equal(capture.options.profileDir, join(app.dataDir, 'users', user.user.id, 'profile'));
  assert.equal(capture.closed, true);

  const tenant = join(app.dataDir, 'users', user.user.id, '.data');
  const rs = RecruitStore.open(join(tenant, 'recruit.db'));
  try {
    const events = rs.listEvents({limit: 10, withProjects: true});
    assert.equal(events.length, 1);
    assert.equal(events[0].sourceUrl, articleUrl);
    assert.equal(events[0].projects.length, 6);
    const feed = readFeed({db: rs.db, dataDir: tenant, userId: user.user.id, types: ['event', 'project']});
    assert.equal(feed.entries.length, 7);
    assert.ok(feed.entries.every(entry => entry.record.source_url === articleUrl));
    assert.ok(feed.entries.every(entry => entry.record.evidence_ref && entry.record.evidence_available));
  } finally { rs.close(); }
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

// ---- AI 兜底与 playbook（#58）----

test('playbook：UIBE/SWUFE/WeChat 各一份，front matter 含入口/domains/成功标志/禁止动作/抽取提示', async () => {
  const playbooks = await listPlaybooks();
  assert.deepEqual(playbooks.map(item => item.id).sort(), ['swufe-xjh', 'uibe-career', 'wechat']);
  for (const pb of playbooks) {
    assert.ok(pb.title, pb.id + ' 缺标题');
    assert.ok(pb.entry.length >= 1, pb.id + ' 缺入口');
    for (const url of pb.entry) assert.match(url, /^https:\/\//, pb.id + ' 入口必须是 https：' + url);
    assert.ok(pb.domains.length >= 1, pb.id + ' 缺 domains');
    assert.ok(pb.successMarkers.length >= 1, pb.id + ' 缺成功标志');
    assert.ok(pb.forbiddenActions.length >= 1, pb.id + ' 缺 forbiddenActions');
    assert.ok(pb.extractHints.length >= 1, pb.id + ' 缺抽取提示');
    assert.ok(pb.markdown.length > 200, pb.id + ' 缺 Markdown 正文');
    const host = new URL(pb.entry[0]).hostname;
    assert.ok(pb.domains.some(domain => host === domain || host.endsWith('.' + domain)), pb.id + ' domains 必须覆盖入口主机 ' + host);
    assert.match(pb.detailSelector, /.+/, pb.id + ' 必须有 detailSelector，兜底才能截到列表 + 详情两页');
  }

  assert.equal((await loadPlaybook('uibe-career')).id, 'uibe-career');
  assert.equal((await loadPlaybook('wechat:wx-anything')).id, 'wechat', '公众号账号复用同一份 wechat playbook');
  assert.equal(await loadPlaybook('sufe-xjh'), null, '没有 playbook 的源返回 null');
  assert.equal((await playbookForSource('wechat:abc')).id, 'wechat');
  assert.equal((await playbookForSource('swufe-xjh')).id, 'swufe-xjh');
  assert.equal(await playbookForSource('sufe-xjh'), null, '采集器源不自动拥有 AI 兜底');

  const pb = await loadPlaybook('uibe-career');
  assert.match(pb.detailSelector, /zph\.jspa/, 'UIBE 兜底必须有详情选择器');
  const steps = playbookSteps(pb);
  assert.equal(steps[0].action, 'goto');
  assert.equal(steps[0].url, pb.entry[0], 'playbook 入口成为第一步 goto');
  assert.equal(steps.at(-1).action, 'screenshot');
  assert.deepEqual(steps.map(step => step.action), ['goto', 'click', 'screenshot']);
  assert.equal(steps[1].target, pb.detailSelector);
  assert.doesNotThrow(() => normalizeOperatorSteps(steps, {source: {listUrl: steps[0].url}}), 'playbook 生成的动作必须能过 operator 校验');

  // successMarkers / extractHints / domains 不是死配置：真的进视觉抽取 prompt。
  const prompt = buildExtractionPrompt({name: '对外经济贸易大学'}, pb);
  for (const marker of pb.successMarkers) assert.ok(prompt.includes(marker), 'prompt 缺成功标志：' + marker);
  for (const hint of pb.extractHints) assert.ok(prompt.includes(hint), 'prompt 缺抽取提示：' + hint);
  for (const domain of pb.domains) assert.ok(prompt.includes(domain), 'prompt 缺允许域提示：' + domain);

  // 西南财大兜底要截到「列表 + 详情」：入口 → 点开第一场详情 → 关键截图。
  const swufe = await loadPlaybook('swufe-xjh');
  assert.match(swufe.detailSelector, /jobfair-show/, 'swufe playbook 要有详情选择器');
  const swufeSteps = playbookSteps(swufe);
  assert.deepEqual(swufeSteps.map(step => step.action), ['goto', 'click', 'screenshot']);
  assert.equal(swufeSteps[1].target, swufe.detailSelector);
  assert.doesNotThrow(() => normalizeOperatorSteps(swufeSteps, {source: {listUrl: swufe.entry[0]}}));
});

test('AI 兜底入口：operator start 接受 sourceId+playbook，用 playbook 入口生成步骤并标明是兜底', {timeout: 60000}, async t => {
  const detailUrl = 'https://career.uibe.edu.cn/front/zph.jspa?tid=2101594239258345474';
  const page = fakeOperatorPage({onAfter: {'a[href*="/front/zph.jspa"]': async target => target.setUrl(detailUrl)}});
  const capture = {};
  // 兜底跑完动作后会复用 source-check 的视觉抽取/写入；这里注入假视觉，不调模型 API。
  const app = await startApp(t, {extractor: fakeExtractor(), operator: {launch: fakeOperatorLauncher(page, capture)}});
  const user = await register(app, 'ai-fallback-user');

  const started = await postJson(app, '/api/source-check/operator/start', user.cookie, {sourceId: 'uibe-career', playbook: 'uibe-career', confirm: true});
  assert.equal(started.mode, 'operator');
  assert.equal(started.fallback, true, '响应要标明这是手动兜底');
  assert.equal(started.playbook, 'uibe-career');
  assert.match(started.title, /AI 兜底/);
  assert.match(started.title, /对外经济贸易大学/);

  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    const task = listed.tasks.find(item => item.id === started.taskId);
    return task && ['succeeded', 'failed'].includes(task.state) ? task : null;
  });
  assert.equal(finished.state, 'succeeded', '兜底任务应完成：' + JSON.stringify(finished.error));
  assert.match(finished.title, /AI 兜底/);
  assert.equal(capture.options.options.headless, false, '兜底仍然用可见窗口');

  // playbook 的入口成为第一步 goto，而不是退回源注册表的 listUrl。
  const goes = page.calls.filter(call => call.action === 'goto').map(call => call.url);
  assert.equal(goes[0], 'https://career.uibe.edu.cn/front/channel.jspa?channelId=766&parentId=625');

  // 兜底也是一次手动读取：来源卡要能显示原因，但不改写采集器 last_run。
  const sources = await getJson(app, '/api/recruit/sources', user.cookie);
  assert.match(sources.manualReads['uibe-career'].reason, /AI 兜底/);

  const mismatch = await postJson(app, '/api/source-check/operator/start', user.cookie, {sourceId: 'swufe-xjh', playbook: 'uibe-career', confirm: true}, 400);
  assert.equal(mismatch.code, 'PLAYBOOK_SOURCE_MISMATCH');
  const unknown = await postJson(app, '/api/source-check/operator/start', user.cookie, {sourceId: 'uibe-career', playbook: 'nope', confirm: true}, 400);
  assert.equal(unknown.code, 'UNKNOWN_PLAYBOOK');
  assert.equal((await getJson(app, '/api/tasks', user.cookie)).tasks.length, 1, '被拒绝的兜底请求不排队任务');
});

test('来源卡 AI 兜底能力：有 playbook 的源与公众号账号标记 aiFallback，采集器源不标记', {timeout: 30000}, async t => {
  const app = await startApp(t, {browserReader: fakeReader('https://x/d'), extractor: fakeExtractor()});
  const user = await register(app, 'ai-fallback-catalog');

  const sources = await getJson(app, '/api/recruit/sources', user.cookie);
  assert.equal(sources.catalog['uibe-career'].aiFallback.available, true);
  assert.equal(sources.catalog['uibe-career'].aiFallback.playbookId, 'uibe-career');
  assert.equal(sources.catalog['swufe-xjh'].aiFallback.playbookId, 'swufe-xjh');
  assert.match(sources.catalog['uibe-career'].aiFallback.note, /这是兜底，不是自动采集/);
  assert.equal(sources.catalog['sufe-xjh'].aiFallback.available, false, '采集器源没有 AI 兜底');
  assert.equal(sources.catalog['ncss'].aiFallback.available, false);

  const created = await postJson(app, '/api/wechat/accounts', user.cookie, {name: '西财校招', school: '西南财经大学'});
  const accountId = created.account.id;
  const withAccount = await getJson(app, '/api/recruit/sources', user.cookie);
  const account = withAccount.wechat.accounts.find(item => item.id === accountId);
  assert.ok(account, '公众号账号要出现在来源卡数据里');
  assert.equal(account.aiFallback.available, false, '公众号不再有 mp 首页的通用 AI 兜底');
  assert.equal(account.aiFallback.playbookId, '');
  assert.equal(account.sourceId, 'wechat:' + accountId, '账号级 AI 采集用账号自己的来源 id');

  const playbooks = await getJson(app, '/api/source-check/playbooks', user.cookie);
  assert.deepEqual(playbooks.playbooks.map(item => item.id).sort(), ['swufe-xjh', 'uibe-career', 'wechat']);
  for (const pb of playbooks.playbooks) {
    assert.ok(pb.entry.length >= 1);
    assert.ok(pb.domains.length >= 1);
    assert.ok(pb.successMarkers.length >= 1);
    assert.ok(pb.forbiddenActions.length >= 1);
    assert.ok(pb.extractHints.length >= 1);
    assert.ok(!Object.hasOwn(pb, 'markdown'), '列表接口不返回整篇正文');
  }
});

test('公众号不再有通用 AI 兜底入口：通用 operator 入口拒绝 wechat playbook，必须走账号级 AI 采集', {timeout: 30000}, async t => {
  const page = fakeOperatorPage();
  const capture = {};
  const app = await startApp(t, {extractor: fakeExtractor(), operator: {launch: fakeOperatorLauncher(page, capture)}});
  const user = await register(app, 'ai-fallback-wechat');

  const started = await postJson(app, '/api/source-check/operator/start', user.cookie, {sourceId: 'wechat:abc-123', playbook: 'wechat', confirm: true}, 400);
  assert.equal(started.code, 'WECHAT_OPERATOR_REQUIRES_ACCOUNT');
  assert.match(started.error, /账号级/);
  assert.equal((await getJson(app, '/api/tasks', user.cookie)).tasks.length, 0, '被拒绝的通用入口不排队任务');
  assert.equal(page.calls.length, 0, '不能打开 mp 首页');
});

test('不自动切换：确定性来源被阻断/失败后不会自动启动 AI 兜底', {timeout: 60000}, async t => {
  const blocked = async () => { throw new SourceCheckBlockedError('来源页需要登录或验证，已停止读取。'); };
  const app = await startApp(t, {browserReader: blocked, extractor: fakeExtractor()});
  const user = await register(app, 'no-auto-fallback');

  const started = await postJson(app, '/api/source-check/start', user.cookie, {sourceId: 'swufe-xjh'});
  const finished = await waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', user.cookie);
    const task = listed.tasks.find(item => item.id === started.taskId);
    return task && ['blocked', 'failed'].includes(task.state) ? task : null;
  });
  assert.equal(finished.state, 'blocked');
  assert.ok(!String(finished.title).includes('AI 兜底'));

  // 失败/阻断只是「值得点兜底」的信号，不是触发器：再等一会儿也不能自己冒出一个兜底任务。
  await wait(300);
  const listed = await getJson(app, '/api/tasks', user.cookie);
  assert.equal(listed.tasks.length, 1, '阻断后不能自动排队 AI 兜底任务');
  assert.equal(listed.tasks.filter(task => String(task.title).includes('AI 兜底')).length, 0);
});

// ---- SWUFE 对照：source-check 与手动 AI 兜底（#60）----

const SWUFE_DETAIL_URL = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';
const SWUFE_DETAIL_SELECTOR = 'a[href*="/jobfair/jobfair-show-"]';
const SWUFE_FIXTURE = JSON.parse(await readFile(new URL('./fixtures/swufe/extraction.json', import.meta.url), 'utf8'));

// 假浏览器：source-check 固定两页；假视觉用同一份 SWUFE fixture，两条路径的输入完全一样。
function swufeReader() {
  const calls = [];
  const reader = async ({source, evidenceDir}) => {
    calls.push({kind: 'list', url: source.listUrl});
    await mkdir(evidenceDir, {recursive: true});
    const at = new Date().toISOString();
    await writeFile(join(evidenceDir, '01-list.png'), PNG);
    calls.push({kind: 'detail', url: SWUFE_DETAIL_URL});
    await writeFile(join(evidenceDir, '02-detail.png'), PNG);
    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: join(evidenceDir, '01-list.png'), url: source.listUrl, title: '双选会列表', at, viewport: {width: 1366, height: 900}},
        {id: 'detail', kind: 'screenshot', file: join(evidenceDir, '02-detail.png'), url: SWUFE_DETAIL_URL, title: SWUFE_FIXTURE.events[0].title, at, viewport: {width: 1366, height: 900}}
      ]
    };
  };
  reader.calls = calls;
  return reader;
}

function swufeExtractor() {
  const calls = [];
  const extractor = async ({screenshots, source}) => {
    calls.push({source: source?.id || '', files: screenshots.map(shot => basename(shot.file))});
    return JSON.parse(JSON.stringify(SWUFE_FIXTURE));
  };
  extractor.calls = calls;
  return extractor;
}

function feedConfig(app, user) {
  return {recruitDir: join(app.dataDir, 'users', user.id, '.data'), dataDir: app.dataDir, userId: user.id};
}

async function waitTask(app, cookie, taskId, states) {
  return waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', cookie);
    const task = listed.tasks.find(item => item.id === taskId);
    return task && states.includes(task.state) ? task : null;
  });
}

function feedEvent(feed) {
  return feed.entries.find(entry => entry.type === 'event') || null;
}

function feedCompanies(feed) {
  return feed.entries.filter(entry => entry.type === 'project').map(entry => entry.record.company).sort();
}

test('SWUFE 对照：source-check 与手动 AI 兜底写同一条记录，字段一致、feed 可见、不重复、可整任务撤销', {timeout: 90000}, async t => {
  const title = SWUFE_FIXTURE.events[0].title;
  const companies = SWUFE_FIXTURE.projects.map(project => project.company);
  const reader = swufeReader();
  const extractor = swufeExtractor();
  const page = fakeOperatorPage({
    title,
    onAfter: {[SWUFE_DETAIL_SELECTOR]: async target => target.setUrl(SWUFE_DETAIL_URL)}
  });
  const capture = {};
  const app = await startApp(t, {browserReader: reader, extractor, operator: {launch: fakeOperatorLauncher(page, capture)}});
  const member = await register(app, 'swufe-compare');
  const config = feedConfig(app, member.user);

  // 1) 确定性 source-check：写入 1 场活动 + 3 个单位，feed 记录带 source_url/evidence_ref/operation_id。
  const first = await postJson(app, '/api/source-check/start', member.cookie, {sourceId: 'swufe'});
  assert.equal(first.sourceId, 'swufe-xjh');
  const firstTask = await waitTask(app, member.cookie, first.taskId, ['succeeded', 'failed', 'blocked']);
  assert.equal(firstTask.state, 'succeeded', 'source-check 应成功：' + JSON.stringify(firstTask.error));
  assert.equal(firstTask.counts.writes, 4, '1 场活动 + 3 个单位');
  assert.deepEqual(reader.calls.map(call => call.kind), ['list', 'detail'], 'source-check 固定读列表 + 详情两页');
  assert.deepEqual(extractor.calls[0].files, ['01-list.png', '02-detail.png']);

  const afterSourceCheck = await callTool('career_feed', {}, {config});
  assert.equal(afterSourceCheck.entries.length, 4, 'feed 能看到 1 场活动 + 3 个单位');
  const eventBefore = feedEvent(afterSourceCheck);
  assert.ok(eventBefore, 'feed 必须有活动条目');
  assert.equal(eventBefore.record.title, title);
  assert.equal(eventBefore.record.school, '西南财经大学');
  assert.equal(eventBefore.record.city, '成都');
  assert.equal(eventBefore.record.kind, '双选会');
  assert.equal(eventBefore.record.source_url, SWUFE_DETAIL_URL);
  assert.equal(eventBefore.record.source_id, 'swufe-xjh', '来源 id 跟随实际来源');
  assert.match(eventBefore.record.operation_id, new RegExp('^' + first.taskId + ':\\d+$'), 'operation_id = taskId:runSeq');
  assert.equal(eventBefore.record.evidence_ref, 'artifact:02-detail.png');
  assert.equal(eventBefore.record.evidence_available, true);
  assert.deepEqual(feedCompanies(afterSourceCheck), [...companies].sort());
  // 兜底/对照记录能被 career_feed({sourceId}) 过滤，不再全部压成 manual。
  const filtered = await callTool('career_feed', {sourceId: 'swufe-xjh'}, {config});
  assert.equal(filtered.entries.length, 4, 'sourceId=swufe-xjh 应能过滤到 4 条');
  const manualFiltered = await callTool('career_feed', {sourceId: 'manual'}, {config});
  assert.equal(manualFiltered.entries.length, 0, '来源 id 已不是 manual');

  // 2) 用户手动点「AI 兜底」：playbook 入口 + 打开详情页 + 截图；抽取/写入复用同一套写网关。
  const fallback = await postJson(app, '/api/source-check/operator/start', member.cookie, {sourceId: 'swufe-xjh', playbook: 'swufe-xjh', confirm: true});
  assert.equal(fallback.fallback, true, '响应要标明这是手动兜底');
  assert.equal(fallback.playbook, 'swufe-xjh');
  assert.match(fallback.title, /AI 兜底/);
  assert.match(fallback.title, /西南财经大学/);
  const fallbackTask = await waitTask(app, member.cookie, fallback.taskId, ['succeeded', 'failed']);
  assert.equal(fallbackTask.state, 'succeeded', 'AI 兜底应成功：' + JSON.stringify(fallbackTask.error));
  assert.equal(capture.options.options.headless, false, '兜底仍然用可见窗口');
  assert.equal(fallbackTask.counts.writes, 4, '兜底写入同一条活动 + 三个单位');
  assert.equal(fallbackTask.undo.available, true, '兜底任务可整任务撤销');
  assert.equal(fallbackTask.undo.rows, 4);

  const actions = fallbackTask.operator.actions.map(item => item.action);
  assert.equal(actions[0], 'goto', 'playbook 入口是第一步');
  assert.ok(actions.includes('click'), '兜底要打开详情页');
  const goes = page.calls.filter(call => call.action === 'goto').map(call => call.url);
  assert.equal(goes[0], 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm');

  // 兜底的证据落在同一个任务目录：动作日志/每步截图 + 抽取 JSON + screenshots.json。
  const fallbackEvidence = join(app.dataDir, 'users', member.user.id, 'tasks', fallback.taskId, 'evidence');
  for (const file of ['action.jsonl', 'screenshots.json', 'extraction.json']) {
    assert.ok(existsSync(join(fallbackEvidence, file)), '兜底证据必须落盘：' + file);
  }
  const fallbackExtraction = JSON.parse(await readFile(join(fallbackEvidence, 'extraction.json'), 'utf8'));
  assert.equal(fallbackExtraction.events.length, 1);
  assert.equal(fallbackExtraction.events[0].title, title, '两条路径的标题一致');
  assert.equal(fallbackExtraction.events[0].sourceUrl, SWUFE_DETAIL_URL, '两条路径的来源一致');
  assert.deepEqual(fallbackExtraction.projects.map(project => project.company), companies, '两条路径的单位一致');
  const fallbackShots = JSON.parse(await readFile(join(fallbackEvidence, 'screenshots.json'), 'utf8'));
  assert.deepEqual(fallbackShots.map(shot => shot.id), ['list', 'detail']);
  assert.equal(fallbackShots[1].url, SWUFE_DETAIL_URL);
  assert.equal(extractor.calls.length, 2, '两条路径各抽取一次');
  assert.deepEqual(extractor.calls[1].files, ['action-001.png', 'action-003.png'], '兜底用 operator 的列表 + 详情动作截图抽取');

  // 3) 对照：同一条活动不被写成两条记录；字段一致，只有证据指针/操作 id 指向兜底任务。
  const afterFallback = await callTool('career_feed', {}, {config});
  assert.equal(afterFallback.entries.length, 4, '两条路径写同一场活动不产生重复记录');
  const eventAfter = feedEvent(afterFallback);
  assert.equal(eventAfter.id, eventBefore.id, '同一场活动仍是同一条记录');
  assert.equal(eventAfter.op, 'upsert');
  for (const field of ['title', 'school', 'city', 'kind', 'venue', 'start_at', 'source_id', 'source_url']) {
    assert.equal(eventAfter.record[field], eventBefore.record[field], field + ' 两条路径必须一致');
  }
  assert.deepEqual(feedCompanies(afterFallback), [...companies].sort(), '单位集合保持一致');
  assert.match(eventAfter.record.operation_id, new RegExp('^' + fallback.taskId + ':\\d+$'), '操作 id 指向兜底任务');
  assert.match(eventAfter.record.evidence_ref, /^artifact:action-\d{3}\.png$/, '证据指向兜底的详情截图');
  assert.equal(eventAfter.record.evidence_available, true);

  const store = RecruitStore.open(join(config.recruitDir, 'recruit.db'));
  let rows;
  try {
    rows = {
      events: store.db.prepare('SELECT * FROM events').all(),
      projects: store.db.prepare('SELECT * FROM event_projects').all(),
      audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all()
    };
  } finally { store.close(); }
  assert.equal(rows.events.length, 1, '不重复写同一场活动');
  assert.equal(rows.projects.length, 3, '不重复写同一个单位');
  assert.equal(rows.audits.length, 8, '两条路径各写 4 行，各留 4 条审计');
  assert.equal(rows.audits.filter(row => row.task_id === first.taskId).length, 4);
  assert.equal(rows.audits.filter(row => row.task_id === fallback.taskId).length, 4);
  assert.ok(rows.audits.filter(row => row.task_id === fallback.taskId).every(row => row.action === 'update'), '兜底更新已有记录而不是新建');

  // 4) 整任务撤销兜底：回到 source-check 写下的值，活动仍在。
  const undoFallback = await postJson(app, '/api/audit/undo/task', member.cookie, {taskId: fallback.taskId});
  assert.equal(undoFallback.ok, true);
  assert.equal(undoFallback.counts.rows, 4);
  assert.equal(undoFallback.counts.undone, 4);
  assert.equal(undoFallback.counts.conflicts, 0);
  assert.equal(undoFallback.task.state, 'undone');
  const afterFallbackUndo = await callTool('career_feed', {}, {config});
  assert.equal(afterFallbackUndo.entries.length, 4, '撤销兜底后 source-check 的记录仍在');
  assert.equal(feedEvent(afterFallbackUndo).record.source_url, SWUFE_DETAIL_URL);

  // 5) 再撤销 source-check：两条路径的记录都清空，整库回到对照前。
  const undoFirst = await postJson(app, '/api/audit/undo/task', member.cookie, {taskId: first.taskId});
  assert.equal(undoFirst.counts.rows, 4);
  assert.equal(undoFirst.counts.undone, 4);
  const afterAllUndo = await callTool('career_feed', {}, {config});
  assert.equal(afterAllUndo.entries.length, 0, '撤销两条任务后没有任何记录残留');
});

test('AI 兜底遇到登录会暂停且不写记录：用户继续/取消前库里保持原样', {timeout: 60000}, async t => {
  const page = fakeOperatorPage({loginAfterGoto: true});
  const app = await startApp(t, {extractor: fakeExtractor(), operator: {launch: fakeOperatorLauncher(page, {})}});
  const member = await register(app, 'swufe-fallback-waiting');
  const config = feedConfig(app, member.user);

  const started = await postJson(app, '/api/source-check/operator/start', member.cookie, {sourceId: 'swufe-xjh', playbook: 'swufe-xjh', confirm: true});
  const waiting = await waitTask(app, member.cookie, started.taskId, ['waiting_login']);
  assert.equal(waiting.state, 'waiting_login');
  assert.equal(waiting.operator.waiting.kind, 'login');
  assert.equal(waiting.counts.writes, 0, '暂停在登录时不能写记录');
  assert.equal((await callTool('career_feed', {}, {config})).entries.length, 0, '暂停在登录时 feed 必须为空');

  await postJson(app, '/api/tasks/stop', member.cookie, {taskId: started.taskId});
  const cancelled = await waitTask(app, member.cookie, started.taskId, ['cancelled']);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await callTool('career_feed', {}, {config})).entries.length, 0, '取消后也不能留下半条记录');
});

test('AI 兜底截图不足时失败关闭：不猜着写库，给出可执行的恢复建议', {timeout: 60000}, async t => {
  const page = fakeOperatorPage();
  const app = await startApp(t, {extractor: fakeExtractor(), operator: {launch: fakeOperatorLauncher(page, {})}});
  const member = await register(app, 'swufe-fallback-shots');
  const config = feedConfig(app, member.user);

  // 自定义步骤只能由服务端注入：HTTP 不再接受 steps，这里直接调进程内服务。
  const started = await app.operator.start({
    user: member.user,
    sourceId: 'swufe-xjh',
    playbook: 'swufe-xjh',
    confirm: true,
    steps: [{action: 'goto', url: 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm'}]
  });
  assert.equal(started.status, 200);
  const finished = await waitTask(app, member.cookie, started.json.taskId, ['failed']);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.error.code, 'OPERATOR_SCREENSHOTS_MISSING');
  assert.match(finished.error.recovery, /重试|手动导入/);
  assert.equal((await callTool('career_feed', {}, {config})).entries.length, 0, '截图不足不能写任何记录');
});

test('AI 兜底列表与详情是同一页时失败关闭（OPERATOR_SAME_PAGE），不写库', {timeout: 60000}, async t => {
  // 假页面点击详情选择器但不跳转：两张截图 URL 相同，正是 #54 评审指出的问题。
  const page = fakeOperatorPage();
  const app = await startApp(t, {extractor: fakeExtractor(), operator: {launch: fakeOperatorLauncher(page, {})}});
  const member = await register(app, 'swufe-fallback-same-page');
  const config = feedConfig(app, member.user);

  const started = await postJson(app, '/api/source-check/operator/start', member.cookie, {
    sourceId: 'swufe-xjh', playbook: 'swufe-xjh', confirm: true
  });
  const finished = await waitTask(app, member.cookie, started.taskId, ['failed']);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.error.code, 'OPERATOR_SAME_PAGE');
  assert.match(finished.error.recovery, /detailSelector|手动导入/);
  assert.equal((await callTool('career_feed', {}, {config})).entries.length, 0, '同一页不能写任何记录');
});
