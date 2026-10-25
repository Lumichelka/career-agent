import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';

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
