// Playwright UI 测试台：真服务 + 真浏览器，覆盖「发消息 → 任务卡 → 证据/草稿 → 390 宽抽屉」。
// 没有浏览器时明确 skip（带原因），不静默通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Playwright UI：登录、发消息，抽屉里出现任务卡（证据与草稿），390 宽不横向溢出', async t => {
  let chromium;
  try {
    ({chromium} = await import('playwright'));
  } catch (error) {
    t.skip('未安装 playwright，跳过 UI 测试：' + error.message);
    return;
  }

  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  mock.state.delayMs = 1200; // 留出观察「运行中」的时间

  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, limits: {taskTimeLimitMs: 60000}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); });

  let browser = null;
  let lastError = '';
  for (const options of [{channel: 'chrome'}, {channel: 'msedge'}, {}]) {
    try {
      browser = await chromium.launch({headless: true, ...options, timeout: 20000});
      break;
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!browser) {
    t.skip('未找到可用浏览器（Chrome / Edge / Playwright），跳过 UI 测试：' + lastError.slice(0, 200));
    return;
  }
  t.after(() => browser.close());

  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(app.origin + '/chat', {waitUntil: 'load'});

  // 登录：注册一个临时账号
  await page.fill('#account-name', 'uitest');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#account-screen')).display === 'none', null, {timeout: 15000});

  // 把模型指向本地假接口，测试不联网
  const saved = await page.evaluate(async url => {
    try {
      await window.__zx.api('model/save', {mode: 'api', protocol: 'chat', baseUrl: url, model: 'mock-model', apiKey: '', preset: 'custom', maxTokens: 2048});
      return 'ok';
    } catch (error) { return error.message; }
  }, mock.url);
  assert.equal(saved, 'ok', '模型设置应保存成功：' + saved);

  // 工作流抽屉由 /workflow.js 注入：入口常驻在顶栏
  await page.waitForSelector('#wf-entry', {timeout: 15000});
  assert.equal((await page.textContent('#wf-badge')).trim(), '0', '没有运行时徽标为 0');

  await page.fill('#input', '研究这个招聘项目，并整理成草稿。');
  await page.click('#send');

  // 运行中徽标应为 1（只计运行中 + 待确认）
  await page.waitForFunction(() => document.querySelector('#wf-badge')?.textContent.trim() === '1', null, {timeout: 15000});
  await page.click('#wf-entry');
  await page.waitForSelector('#wf-drawer-body .task', {timeout: 15000});
  assert.match(await page.textContent('#wf-drawer-body'), /运行中|排队中/, '抽屉里应出现任务卡');

  await page.waitForSelector('#wf-drawer-body .task[data-state="succeeded"]', {timeout: 30000});
  const cardText = await page.textContent('#wf-drawer-body');
  assert.match(cardText, /已完成/);
  assert.match(cardText, /证据（\d+）/);
  assert.match(cardText, /草稿 · 双选会参会单位草稿/);
  assert.ok(await page.locator('#wf-drawer-body .task .evidence .ev').count() >= 1, '任务卡应显示证据条目');
  assert.equal((await page.textContent('#wf-badge')).trim(), '0', '任务结束后徽标回到 0');
  assert.equal(await page.locator('#wf-drawer-body [data-group="done"]').count(), 1, '应有已完成分组');

  // 桌面：400 宽，推开主内容而不是盖住
  const desktop = await page.evaluate(() => {
    const drawer = document.querySelector('#wf-drawer').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    return {innerWidth, drawerLeft: drawer.left, drawerWidth: drawer.width, mainRight: main.right};
  });
  assert.ok(Math.abs(desktop.drawerWidth - 400) < 1, '桌面抽屉宽 400，实际 ' + desktop.drawerWidth);
  assert.ok(Math.abs(desktop.mainRight - (desktop.innerWidth - 400)) <= 2, '主内容应被推开 400，实际 ' + desktop.mainRight + ' / ' + desktop.innerWidth);
  assert.ok(desktop.drawerLeft >= desktop.mainRight - 1, '抽屉不应盖住主内容');

  // 手机：底部抽屉 72vh，无横向溢出
  await page.setViewportSize({width: 390, height: 844});
  await page.click('#wf-close');
  await page.waitForTimeout(250);
  await page.click('#wf-entry');
  await page.waitForTimeout(350);
  const mobile = await page.evaluate(() => {
    const drawer = document.querySelector('#wf-drawer').getBoundingClientRect();
    return {
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      width: drawer.width,
      height: drawer.height,
      bottom: innerHeight - drawer.bottom
    };
  });
  assert.ok(Math.abs(mobile.width - 390) < 1, '手机抽屉应全宽，实际 ' + mobile.width);
  assert.ok(Math.abs(mobile.height - mobile.innerHeight * 0.72) < 2, '手机抽屉应为 72vh，实际 ' + mobile.height);
  assert.ok(mobile.scrollWidth <= 390, '390 宽不应横向溢出，实际 scrollWidth=' + mobile.scrollWidth);
  assert.ok(Math.abs(mobile.bottom) < 1, '底部抽屉应贴底：' + JSON.stringify(mobile));
  assert.equal(pageErrors.length, 0, '页面不应有脚本错误：' + pageErrors.join(' | '));
});
