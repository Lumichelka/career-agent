import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {SourceCheckBlockedError} from '../src/source-check/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const DETAIL_URL = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';

function fixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/swufe/extraction.json', import.meta.url), 'utf8'));
}

// 浏览器不可用时明确跳过，绝不静默通过。本机装了 Microsoft Edge，优先用它。
async function launchBrowser(t, port) {
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try {
    return await chromium.launch({channel: 'msedge', headless: true, args});
  } catch (error) {
    firstError = error.message;
  }
  try {
    return await chromium.launch({headless: true, args});
  } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}


function operatorPage({loginAfterGoto = true, onAfter = {}} = {}) {
  const calls = [];
  const handlers = new Map();
  const listUrl = 'https://mp.weixin.qq.com/s/example';
  let currentUrl = listUrl;
  const page = {
    calls,
    url: () => currentUrl,
    setUrl: value => { currentUrl = String(value); },
    title: async () => (currentUrl.includes('/login') ? '登录' : '文章列表'),
    goto: async url => { calls.push({action: 'goto', url}); currentUrl = loginAfterGoto ? 'https://mp.weixin.qq.com/login' : url; },
    click: async selector => {
      calls.push({action: 'click', selector});
      if (onAfter[selector]) await onAfter[selector](page);
    },
    evaluate: async script => (typeof script === 'function' ? '文章列表' : '文章列表'),
    screenshot: async ({path}) => { await writeFile(path, PNG); },
    waitForTimeout: async () => {},
    on: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); return page; },
    emit: async (name, value) => { for (const handler of handlers.get(name) || []) await handler(value); }
  };
  return page;
}

function operatorLauncher(page, capture) {
  const context = {pages: () => [page], newPage: async () => page, route: async () => {}, on: () => {}, close: async () => { capture.closed = true; }};
  return async options => { capture.options = options; return context; };
}

test('operator 任务卡：等待登录时显示动作时间线与人工接管，点「已登录，继续」后完成', {timeout: 180000}, async t => {
  const pageModel = operatorPage({loginAfterGoto: true});
  const capture = {};
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-operator-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, sourceCheck: {operator: {launch: operatorLauncher(pageModel, capture)}}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-operator');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');
  // HTTP 不接受客户端 steps：只给 URL + confirm，服务端生成默认两步计划。
  const startedResponse = await fetch(app.origin + '/api/source-check/operator/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify({url: 'https://mp.weixin.qq.com/s/example', confirm: true})
  });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();

  await page.goto(app.origin + '/chat?session=' + started.sessionId + '&workflow=open');
  await page.waitForSelector('#workflow-drawer .task-card[data-state="waiting_login"]', {state: 'visible', timeout: 30000});
  const card = page.locator('#workflow-drawer .task-card').first();
  const waitingText = await card.innerText();
  assert.match(waitingText, /等待登录/);
  assert.match(waitingText, /人工接管/);
  assert.match(waitingText, /步骤 1/);
  assert.match(waitingText, /打开页面/);
  assert.match(waitingText, /页面需要登录/);
  assert.equal(capture.options.options.headless, false, '任务卡对应的是可见浏览器 profile');
  assert.ok(await card.locator('[data-operator-action="continue"]').count() === 1, '等待登录要有「已登录，继续」');

  pageModel.setUrl('https://mp.weixin.qq.com/s/example');
  await card.locator('[data-operator-action="continue"]').click();
  await page.waitForSelector('#workflow-drawer .task-card[data-state="succeeded"]', {timeout: 30000});
  const finishedText = await page.locator('#workflow-drawer .task-card').first().innerText();
  assert.match(finishedText, /步骤 2/);
  assert.match(finishedText, /截图/);
  assert.match(finishedText, /成功/);

  const layout = await page.evaluate(() => {
    const drawer = document.querySelector('#workflow-drawer').getBoundingClientRect();
    const body = document.querySelector('#workflow-body');
    return {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, drawerWidth: drawer.width, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth};
  });
  assert.ok(layout.scrollWidth <= 390, '390 宽不能横向溢出，实际 ' + layout.scrollWidth);
  assert.ok(layout.drawerWidth <= 390.5);
  assert.ok(layout.bodyScroll <= layout.bodyClient + 1, '任务卡时间线不能横向溢出');

  // 第二条：危险动作在任务卡上硬确认；拒绝后不点击，任务继续完成。
  // 自定义步骤只能由服务端注入（HTTP 已拒绝 steps），这里直接调进程内服务。
  const me = await (await fetch(app.origin + '/api/auth/me', {headers: {'x-career-token': app.token, cookie}})).json();
  const confirmOut = await app.operator.start({
    user: {id: me.user.id},
    url: 'https://career.uibe.edu.cn/zhaopin/',
    confirm: true,
    steps: [
      {action: 'click', target: '#apply', text: '投递简历'},
      {action: 'evaluate', script: 'document.title'}
    ]
  });
  assert.equal(confirmOut.status, 200);
  const confirmStarted = confirmOut.json;
  const confirmCardSelector = '#workflow-drawer .task-card[data-task-id="' + confirmStarted.taskId + '"]';
  await page.waitForSelector(confirmCardSelector + '[data-state="waiting_confirmation"]', {state: 'visible', timeout: 30000});
  const confirmCard = page.locator(confirmCardSelector);
  const confirmText = await confirmCard.innerText();
  assert.match(confirmText, /人工接管/);
  assert.match(confirmText, /投递/);
  assert.match(confirmText, /接受并继续/);
  assert.match(confirmText, /拒绝这一步/);
  await confirmCard.locator('[data-operator-confirm="reject"]').click();
  await page.waitForSelector(confirmCardSelector + '[data-state="succeeded"]', {timeout: 30000});
  assert.equal(pageModel.calls.filter(call => call.action === 'click').length, 0, '拒绝后危险点击不能执行');
  const confirmFinished = await page.locator(confirmCardSelector).innerText();
  assert.match(confirmFinished, /已拒绝/);
});

test('来源卡「来源校对」→ 切回对话并打开抽屉；390 宽不溢出；来源卡记最近手动读取', {timeout: 180000}, async t => {
  const reader = async ({source, evidenceDir}) => {
    // 留出时间让任务卡先显示「运行中」，再完成读取。
    await new Promise(resolve => setTimeout(resolve, 3000));
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
  const extractor = async () => fixture();
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-source-check-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, sourceCheck: {browserReader: reader, extractor}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();

  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-source-check');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  // 数据页：西南财大来源卡即使在采集器禁用时也有「来源校对」。
  await page.goto(app.origin + '/recruit?tab=sources');
  await page.waitForSelector('#sources .src-row', {state: 'visible', timeout: 15000});
  const row = page.locator('#sources .src-row', {has: page.locator('[data-source-check="swufe-xjh"]')});
  await row.waitFor({state: 'visible', timeout: 15000});
  const rowText = await row.innerText();
  assert.match(rowText, /西南财经大学/);
  assert.match(rowText, /未接入/, '采集器禁用的来源仍显示未接入');
  assert.ok(!rowText.includes('已接入'), '来源卡不能改成已接入');
  const button = page.locator('[data-source-check="swufe-xjh"]');
  assert.equal(await button.isDisabled(), false, '采集器禁用时来源校对按钮仍可点');
  await button.click();

  // 只发起、不额外确认：立刻换到对话页并打开工作流抽屉。
  await page.waitForURL(url => url.pathname === '/chat' && url.searchParams.get('workflow') === 'open' && !!url.searchParams.get('session'), {timeout: 20000});
  await page.waitForFunction(() => document.body.classList.contains('workflow-open'), null, {timeout: 20000});
  assert.equal(await page.getAttribute('#workflow-drawer', 'aria-hidden'), 'false');

  // 任务卡是运行中的来源校对任务。
  const runningCard = page.locator('#workflow-drawer .task-card[data-state="running"]');
  await runningCard.waitFor({state: 'visible', timeout: 15000});
  const runningText = await runningCard.innerText();
  assert.match(runningText, /来源校对/);
  assert.match(runningText, /西南财经大学/);

  // 完成后任务卡显示证据（2 张截图 + 抽取 JSON）与写入/批次计数。
  await page.waitForSelector('#workflow-drawer .task-card[data-state="succeeded"]', {timeout: 30000});
  const cardText = await page.locator('#workflow-drawer .task-card').first().innerText();
  assert.match(cardText, /截图 1 · 列表页/);
  assert.match(cardText, /截图 2 · 活动详情/);
  assert.match(cardText, /抽取 JSON（联系方式已剔除）/);
  assert.match(cardText, /自动写入 4 条/);
  assert.match(cardText, /批次 1/);
  assert.ok(await page.locator('#workflow-drawer .task-evidence a').count() >= 3, '证据要有可打开的截图/JSON 链接');

  // 390×844：整页与抽屉都不横向溢出，手机底部抽屉样式成立。
  const layout = await page.evaluate(() => {
    const drawer = document.querySelector('#workflow-drawer').getBoundingClientRect();
    const body = document.querySelector('#workflow-body');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      drawer: {x: drawer.x, y: drawer.y, width: drawer.width, height: drawer.height},
      bodyScroll: body.scrollWidth,
      bodyClient: body.clientWidth
    };
  });
  assert.ok(layout.scrollWidth <= 390, '390 宽下整页不能横向溢出，实际 ' + layout.scrollWidth);
  assert.ok(layout.clientWidth <= 390);
  assert.ok(layout.drawer.width <= 390.5, '手机抽屉占满视口宽，实际 ' + layout.drawer.width);
  assert.ok(layout.drawer.y > 100, '手机抽屉贴底部，实际 y=' + layout.drawer.y);
  assert.ok(layout.bodyScroll <= layout.bodyClient + 1, '抽屉内容不能横向溢出');

  // 回到数据页：来源卡记「最近手动读取 + 原因」，不改写采集器 last_run 语义。
  await page.goto(app.origin + '/recruit?tab=sources');
  await page.waitForSelector('[data-source-check="swufe-xjh"]', {state: 'visible', timeout: 15000});
  const updatedRow = page.locator('#sources .src-row', {has: page.locator('[data-source-check="swufe-xjh"]')});
  await page.waitForFunction(() => document.querySelector('#sources')?.textContent?.includes('最近手动读取'), null, {timeout: 15000});
  const updatedText = await updatedRow.innerText();
  assert.match(updatedText, /最近手动读取/);
  assert.match(updatedText, /采集器已禁用/);
  assert.ok(!updatedText.includes('已接入'), '记了手动读取也不能显示已接入');
});

test('来源卡「AI 兜底」：手动入口、明示不是自动采集、阻断后不自动切换、点击确认后才跑 operator 任务', {timeout: 180000}, async t => {
  const swufeDetail = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';
  const pageModel = operatorPage({
    loginAfterGoto: false,
    onAfter: {'a[href*="/jobfair/jobfair-show-"]': async target => target.setUrl(swufeDetail)}
  });
  const capture = {};
  const blockedReader = async () => { throw new SourceCheckBlockedError('来源页需要登录或验证，已停止读取。'); };
  // 兜底跑完动作后复用 source-check 的视觉抽取/写入；UI 测试同样不调模型 API。
  const fakeExtractor = async () => ({
    events: [{title: '西南财经大学2026届秋季双选会', startAt: '2026-11-05T09:00:00+08:00', school: '西南财经大学', city: '成都', kind: '双选会'}],
    projects: [{eventRef: 0, company: '中国银行四川省分行', title: '管理培训生'}]
  });
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-ai-fallback-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, sourceCheck: {browserReader: blockedReader, extractor: fakeExtractor, operator: {launch: operatorLauncher(pageModel, capture)}}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-ai-fallback');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');
  const apiHeaders = {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};

  // 公众号账号用于验证「通用 AI 兜底入口已移除」。
  const accountResponse = await fetch(app.origin + '/api/wechat/accounts', {method: 'POST', headers: apiHeaders, body: JSON.stringify({name: '西财校招', school: '西南财经大学'})});
  assert.equal(accountResponse.status, 200);
  const account = (await accountResponse.json()).account;

  // 确定性 source-check 被阻断：任务标 blocked，但绝不自动切 AI。
  const startedResponse = await fetch(app.origin + '/api/source-check/start', {method: 'POST', headers: apiHeaders, body: JSON.stringify({sourceId: 'swufe-xjh'})});
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  const deadline = Date.now() + 20000;
  let tasks = [];
  while (Date.now() < deadline) {
    tasks = (await (await fetch(app.origin + '/api/tasks', {headers: apiHeaders})).json()).tasks;
    if (tasks.some(task => task.id === started.taskId && ['blocked', 'failed'].includes(task.state))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(tasks.find(task => task.id === started.taskId)?.state, 'blocked');
  assert.equal(tasks.length, 1, '确定性来源被阻断后不能自动产生 AI 兜底任务');
  assert.ok(!JSON.stringify(tasks).includes('AI 兜底'));

  await page.goto(app.origin + '/recruit?tab=sources');
  await page.waitForSelector('#sources .src-row', {state: 'visible', timeout: 15000});

  // UI 明示：这张卡上的入口是兜底，不是自动采集。
  const panelText = await page.locator('#sources-panel').innerText();
  assert.match(panelText, /这是兜底，不是自动采集/);

  // 健康的确定性源也有手动入口（用户点击即可），只是不提示「建议兜底」。
  assert.equal(await page.locator('[data-ai-fallback="uibe-career"]').count(), 1);
  assert.equal(await page.locator('[data-ai-fallback="swufe-xjh"]').count(), 1);

  const swufeRow = page.locator('#sources .src-row', {has: page.locator('[data-ai-fallback="swufe-xjh"]')});
  await swufeRow.waitFor({state: 'visible', timeout: 15000});
  const swufeText = await swufeRow.innerText();
  assert.match(swufeText, /AI 兜底/);
  assert.match(swufeText, /确定性采集被阻断/, '确定性来源被阻断后提示可以手动兜底');
  const swufeButton = page.locator('[data-ai-fallback="swufe-xjh"]');
  assert.equal(await swufeButton.isDisabled(), false, '手动入口可点');
  assert.equal(await swufeButton.getAttribute('data-playbook'), 'swufe-xjh');
  assert.match(await swufeButton.getAttribute('title'), /不是自动采集/);

  // 公众号只保留账号级「AI 采集」：账号行不再有 mp 首页的通用 AI 兜底入口。
  const wxRow = page.locator('#sources .src-row', {hasText: '西财校招'});
  await wxRow.waitFor({state: 'visible', timeout: 15000});
  assert.equal(await page.locator('[data-ai-fallback="wechat:' + account.id + '"]').count(), 0, '公众号不能再用通用 wechat playbook 兜底');

  // 用户点击后先弹一次确认；确认才运行，playbook 入口成为第一步。
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await swufeButton.click();
  await page.waitForURL(url => url.pathname === '/chat' && url.searchParams.get('workflow') === 'open' && !!url.searchParams.get('session'), {timeout: 20000});
  const succeededCard = page.locator('#workflow-drawer .task-card[data-state="succeeded"]');
  await succeededCard.waitFor({state: 'visible', timeout: 30000});
  const cardText = await succeededCard.innerText();
  assert.match(cardText, /AI 兜底/);
  assert.match(cardText, /西南财经大学/);
  assert.match(cardText, /打开页面/);
  assert.match(cardText, /成功/);
  assert.equal(dialogs.length, 1, 'AI 兜底起任务前必须确认一次');
  assert.match(dialogs[0], /AI 兜底|确认/);

  const after = (await (await fetch(app.origin + '/api/tasks', {headers: apiHeaders})).json()).tasks;
  assert.equal(after.length, 2, '点击后恰好新增一个兜底任务');
  assert.equal(after.filter(task => String(task.title).includes('AI 兜底')).length, 1);
});
