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
const ISSUES = [
  {row: 'events[0]', field: 'title', issue: '标题可能漏了“秋季”', severity: 'medium'},
  {row: 'projects[1]', field: 'company', issue: '单位名像是简称', severity: 'low'}
];

function fixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/swufe/extraction.json', import.meta.url), 'utf8'));
}

// 浏览器不可用时明确跳过，绝不静默通过。本机装了 Microsoft Edge，优先用它。
async function launchBrowser(t, port) {
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true, args}); }
  catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true, args}); }
  catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

test('任务卡显示复核问题数并可展开；助手消息调用表有 step=review；390 宽不溢出', {timeout: 180000}, async t => {
  const reader = async ({source, evidenceDir}) => {
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
  const reviewer = async () => ({ok: true, issues: ISSUES, agent: {id: 'fake-reviewer', name: '复核助手'}, tool: 'review_extraction'});
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-agent-review-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, sourceCheck: {browserReader: reader, extractor, reviewer}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-agent-review');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  await page.goto(app.origin + '/recruit?tab=sources');
  await page.waitForSelector('[data-source-check="swufe-xjh"]', {state: 'visible', timeout: 15000});
  await page.click('[data-source-check="swufe-xjh"]');
  await page.waitForURL(url => url.pathname === '/chat' && url.searchParams.get('workflow') === 'open', {timeout: 20000});
  await page.waitForFunction(() => document.body.classList.contains('workflow-open'), null, {timeout: 20000});

  await page.waitForSelector('#workflow-drawer .task-card[data-state="succeeded"]', {timeout: 30000});
  const card = page.locator('#workflow-drawer .task-card').first();
  const summary = card.locator('.task-review summary');
  await summary.waitFor({state: 'visible', timeout: 15000});
  assert.equal((await summary.innerText()).trim(), '复核 2 个问题');

  // 展开后逐条显示 row / field / issue。
  await summary.click();
  const items = card.locator('.task-review-list li');
  await items.first().waitFor({state: 'visible', timeout: 10000});
  assert.equal(await items.count(), 2);
  const listText = await card.locator('.task-review-list').innerText();
  assert.match(listText, /标题可能漏了/);
  assert.match(listText, /单位名像是简称/);
  assert.match(listText, /events\[0\]/);
  assert.match(listText, /projects\[1\]/);

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScroll: document.querySelector('#workflow-body').scrollWidth,
    bodyClient: document.querySelector('#workflow-body').clientWidth
  }));
  assert.ok(layout.scrollWidth <= 390, '390 宽下整页不能横向溢出，实际 ' + layout.scrollWidth);
  assert.ok(layout.bodyScroll <= layout.bodyClient + 1, '抽屉内容不能横向溢出');

  // 复核调用只出现在助手消息的调用表里；手机上抽屉会盖住对话区，先关抽屉再展开。
  await page.reload();
  await page.waitForSelector('.msg.assistant .calls', {state: 'visible', timeout: 30000});
  await page.click('#workflow-close');
  await page.waitForFunction(() => document.querySelector('#workflow-drawer')?.getAttribute('aria-hidden') === 'true', null, {timeout: 10000});
  const calls = page.locator('.msg.assistant .calls').last();
  assert.match(await calls.locator('summary').innerText(), /本次调用/);
  await calls.locator('summary').click();
  const callText = await calls.locator('table').innerText();
  assert.match(callText, /复核/);
  assert.match(callText, /复核助手/);
});
