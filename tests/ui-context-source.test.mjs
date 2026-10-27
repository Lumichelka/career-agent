import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

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

async function login(page, app) {
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-context');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
}

test('上下文抽屉显示项目自己的来源（名称 + 链接）', {timeout: 120000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-context-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  await login(page, app);
  const me = await page.evaluate(() => window.__zx.api('auth/me'));
  const userDir = join(dir, 'users', me.user.id, '.data');
  await mkdir(userDir, {recursive: true});

  let project;
  const store = RecruitStore.open(join(userDir, 'recruit.db'));
  try {
    store.syncSources([{id: 'test-src', name: '测试来源', school: '测试大学', city: '测试市', category: 'test', channel: 'web', listUrl: 'https://example.com/source', mode: 'http', enabled: true}]);
    store.upsertEvent({id: 'e1', sourceId: 'test-src', school: '测试大学', title: '秋季双选会', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString(), sourceUrl: 'https://example.com/event/1'});
    project = store.upsertProject({eventId: 'e1', company: '测试科技有限公司', title: '数据分析', sourceUrl: 'https://example.com/job/9', sourceId: 'test-src'});
  } finally { store.close(); }

  await page.goto(app.origin + '/chat?project=' + project.id);
  await page.waitForSelector('#context-panel', {state: 'visible'});
  await page.waitForFunction(() => (document.querySelector('#context-panel')?.innerText || '').includes('测试来源'), null, {timeout: 15000});
  const panel = page.locator('#context-panel');
  const text = await panel.innerText();
  assert.match(text, /来源：/);
  assert.match(text, /测试来源/);
  assert.match(text, /测试科技有限公司/);
  const href = await panel.locator('a', {hasText: '测试来源'}).getAttribute('href');
  assert.equal(href, 'https://example.com/job/9');
});

test('来源页采集结果展示跳过数、文章摘要与需粘贴提示', {timeout: 120000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-harvest-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  await login(page, app);

  await page.route('**/api/wechat/harvest', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      links: 2, imported: 1, skipped: 1,
      articles: [{id: 'a1', title: '某公司双选会', account: '就业中心', hasRecruitment: 'yes', projects: 2, summary: '某公司 招聘 数据分析'}],
      failures: [{link: 'https://mp.weixin.qq.com/s/two', message: '微信要求验证或正文为空；请把推文正文粘贴进来', needPaste: true}]
    })
  }));

  await page.goto(app.origin + '/recruit?tab=sources&type=wechat');
  await page.waitForSelector('#wx-harvest', {state: 'visible'});
  await page.evaluate(() => {
    document.querySelector('#wx-url').value = 'https://example.com/source';
    document.querySelector('#wx-harvest').click();
  });
  await page.waitForFunction(() => (document.querySelector('#wx-result')?.innerText || '').includes('跳过 1 篇'), null, {timeout: 15000});
  const text = await page.locator('#wx-result').innerText();
  assert.match(text, /发现 2 个链接，入库 1 篇，跳过 1 篇/);
  assert.match(text, /某公司 招聘 数据分析/);
  assert.match(text, /微信要求验证/);
  assert.equal(await page.locator('#wx-result a[href="https://mp.weixin.qq.com/s/two"]').count(), 1);
});
