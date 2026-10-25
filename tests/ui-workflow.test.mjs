import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 浏览器不可用时明确跳过，绝不静默通过。本机装了 Microsoft Edge，优先用它。
async function launchBrowser(t) {
  let firstError = '';
  try {
    return await chromium.launch({channel: 'msedge', headless: true});
  } catch (error) {
    firstError = error.message;
  }
  try {
    return await chromium.launch({headless: true});
  } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

async function saveModel(app, cookie, baseUrl) {
  const response = await fetch(app.origin + '/api/model/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify({mode: 'local', protocol: 'chat', baseUrl, model: 'mock-model', stream: true})
  });
  const body = await response.text();
  assert.equal(response.status, 200, '保存模型设置失败：' + body);
}

test('工作流抽屉：发消息后出现任务卡，390 宽不横向溢出，桌面抽屉推开主内容', {timeout: 180000}, async t => {
  const mock = await startMockOpenAI({delayMs: 500});
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-workflow-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();

  // 真登录：走页面上的账号表单，不直接塞 cookie。
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-tester');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  const cookieHeader = (await context.cookies(app.origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  assert.match(cookieHeader, /career_auth=/, '页面登录后应有会话 cookie');
  await saveModel(app, cookieHeader, mock.url);

  // Edge + 负载抖动时偶发浏览器侧断流；重试一次完整「发消息 → 任务卡成功」，失败时给出记录详情。
  async function sendAndAwaitCard(attempt) {
    await page.fill('#input', '帮我做一次来源校对');
    await page.click('#send');

    // 任务一亮起，顶栏徽标就要计数（运行中 + 待确认）。
    await page.waitForFunction(() => Number(document.querySelector('#workflow-count')?.textContent || 0) >= 1, null, {timeout: 30000});
    assert.equal(await page.getAttribute('#workflow-toggle', 'aria-expanded'), 'false', '抽屉默认收起');
    await page.click('#workflow-toggle');
    await page.waitForSelector('#workflow-drawer .task-card', {state: 'visible', timeout: 10000});

    const firstCard = page.locator('#workflow-drawer .task-card').first();
    assert.match(await firstCard.innerText(), /对话/, '任务卡显示来源名');
    assert.ok(await page.locator('#workflow-drawer .task-evidence').count() >= 1, '任务卡要有证据区块');
    assert.ok(await page.locator('#workflow-drawer .task-drafts').count() >= 1, '任务卡要有草稿区块');
    assert.ok(await page.locator('#workflow-drawer .task-undo').count() >= 1, '任务卡要有撤销摘要占位');

    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('#workflow-drawer .task-card')].some(card => card.textContent.includes('成功')),
        null,
        {timeout: attempt === 1 ? 45000 : 60000}
      );
    } catch (error) {
      const drawer = await page.locator('#workflow-body').innerText().catch(() => '');
      const status = await page.locator('#status').innerText().catch(() => '');
      let tasks = '';
      try {
        const listed = await (await fetch(app.origin + '/api/tasks', {headers: {'x-career-token': app.token, cookie: cookieHeader}})).json();
        tasks = listed.tasks.map(task => task.state + '/' + (task.error ? task.error.code + ':' + task.error.message : 'no-error')).join(' | ');
      } catch { /* 诊断失败就算了 */ }
      throw new Error('第 ' + attempt + ' 次任务卡没有变成成功。状态栏：' + status + '；任务：' + tasks + '；抽屉：' + drawer.slice(-600));
    }
    await page.waitForFunction(() => document.querySelector('#workflow-count')?.textContent === '0', null, {timeout: 15000});
  }

  try {
    await sendAndAwaitCard(1);
  } catch (firstError) {
    // 只重试浏览器侧偶发断流；第二次仍失败就带着两次记录失败。
    await page.evaluate(() => window.__workflow?.close()).catch(() => {});
    await page.waitForFunction(() => document.querySelector('#stop')?.hidden === true, null, {timeout: 20000}).catch(() => {});
    await page.click('#mobile-new').catch(() => {});
    await page.waitForTimeout(300);
    await sendAndAwaitCard(2);
  }

  const mobile = await page.evaluate(() => {
    const drawer = document.querySelector('#workflow-drawer').getBoundingClientRect();
    const body = document.querySelector('#workflow-body');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      drawer: {x: drawer.x, y: drawer.y, width: drawer.width, height: drawer.height},
      body: {scrollWidth: body.scrollWidth, clientWidth: body.clientWidth},
      groups: [...document.querySelectorAll('#workflow-drawer .workflow-group')].map(group => group.dataset.group)
    };
  });
  assert.ok(mobile.scrollWidth <= 390, '390×844 下整页不能横向溢出，实际 scrollWidth=' + mobile.scrollWidth);
  assert.ok(mobile.clientWidth <= 390);
  assert.ok(mobile.drawer.width <= 390.5, '手机抽屉应占满视口宽，实际 ' + mobile.drawer.width);
  assert.ok(mobile.drawer.y > 100, '手机抽屉应贴在底部，实际 y=' + mobile.drawer.y);
  assert.ok(mobile.drawer.height > 500 && mobile.drawer.height <= 610, '手机抽屉应为 72vh，实际 ' + mobile.drawer.height);
  assert.ok(mobile.body.scrollWidth <= mobile.body.clientWidth + 1, '抽屉内容不能横向溢出');
  assert.deepEqual(mobile.groups, ['running', 'waiting', 'drafts', 'undo', 'failed'], '抽屉按五个状态分组');
  const cardState = await page.locator('#workflow-drawer .task-card').first().getAttribute('data-state');
  assert.equal(cardState, 'succeeded');

  // 桌面：400 宽抽屉，打开时把主内容挤窄而不是盖住。
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#input', {state: 'visible'});
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  await page.click('#workflow-toggle');
  await page.waitForSelector('#workflow-drawer .task-card', {state: 'visible', timeout: 10000});
  assert.match(await page.locator('#workflow-drawer .task-card').first().innerText(), /成功/, '刷新页面后仍能从记录里恢复任务卡');
  await page.waitForTimeout(300);
  const desktop = await page.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect();
    const drawer = document.querySelector('#workflow-drawer').getBoundingClientRect();
    return {main: {x: main.x, width: main.width}, drawer: {x: drawer.x, width: drawer.width}, scrollWidth: document.documentElement.scrollWidth};
  });
  assert.ok(Math.abs(desktop.drawer.width - 400) <= 1, '桌面抽屉应宽 400，实际 ' + desktop.drawer.width);
  assert.ok(desktop.drawer.x >= desktop.main.x + desktop.main.width - 1, '抽屉应推开主内容，main 右边界 ' + (desktop.main.x + desktop.main.width) + '，抽屉左边界 ' + desktop.drawer.x);
  assert.ok(desktop.main.width <= 1280 - 258 - 398, '主内容应被抽屉挤窄，实际 ' + desktop.main.width);
  assert.ok(desktop.scrollWidth <= 1280, '桌面也不应出现横向溢出');
});
