import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function launchBrowser(t) {
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true}); } catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true}); } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

async function call(app, cookie, path, body) {
  const response = await fetch(app.origin + path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify(body || {})
  });
  if (response.status !== 200) assert.equal(response.status, 200, path + ' 失败：' + await response.text());
  return response.json();
}

test('回退建议 UI：失败只出一个「换 X 重试」按钮，点击后重跑成功；有工具成功时只给重试', {timeout: 180000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-fallback-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  // 用 node.exe 冒充本机 Codex：立刻失败，模拟「Codex 不可用」，换到已配置的 API 后端。
  const beforeCodex = process.env.CAREER_CODEX_PATH;
  process.env.CAREER_CODEX_PATH = process.execPath;
  t.after(() => {
    if (beforeCodex === undefined) delete process.env.CAREER_CODEX_PATH;
    else process.env.CAREER_CODEX_PATH = beforeCodex;
  });

  const browser = await launchBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();

  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  const ownerFile = await readFile(join(dir, '首次登录.txt'), 'utf8');
  const password = ownerFile.match(/密码：(.+)/)?.[1]?.trim();
  assert.ok(password);
  await page.fill('#account-name', 'owner');
  await page.fill('#account-password', password);
  await page.click('#account-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');

  await call(app, cookie, '/api/model/save', {preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: mock.url, model: 'deepseek-flash', apiKey: 'sk-ui-fallback', stream: true});
  await call(app, cookie, '/api/backends/select', {kind: 'codex'});
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  // 失败且本轮没有工具成功：出现且只出现一个「换 X 重试（约 ¥x）」。
  await page.fill('#input', '帮我整理这次双选会');
  await page.click('#send');
  await page.waitForSelector('.turn-actions .fallback-retry', {state: 'visible', timeout: 45000});
  const actions = page.locator('.turn-actions');
  assert.equal(await actions.count(), 1, '失败区只有一组操作');
  assert.equal(await actions.locator('button').count(), 1, '只给一个换后端按钮');
  const label = await actions.locator('.fallback-retry').innerText();
  assert.match(label, /换 .+ 重试/);
  assert.match(label, /≈¥/, '有价的后端带「约 ¥x」');

  // 点一次：切换后端并用同一条消息重跑整轮，调用记录标回退。
  await actions.locator('.fallback-retry').click();
  await page.waitForSelector('.msg.assistant .calls', {state: 'visible', timeout: 45000});
  assert.equal(await page.locator('.turn-actions').count(), 0, '重跑成功后建议按钮消失');
  await page.locator('.msg.assistant .calls summary').last().click();
  const notes = await page.locator('.msg.assistant .calls table tbody tr td:last-child').allInnerTexts();
  assert.ok(notes.every(note => note.includes('回退')), '调用记录标回退：' + notes.join('|'));

  // 本轮已有工具成功后再失败：只给「重试」，不给换后端建议。
  await call(app, cookie, '/api/backends/select', {kind: 'api'});
  mock.state.failAfterTool = true;
  await page.fill('#input', '研究这个招聘项目');
  await page.click('#send');
  await page.waitForSelector('.turn-actions [data-retry-same]', {state: 'visible', timeout: 45000});
  assert.equal(await page.locator('[data-fallback-kind]').count(), 0, '有工具成功时不给换后端建议');
  assert.equal(await page.locator('.turn-actions button').count(), 1);
  assert.match(await page.locator('.turn-actions button').innerText(), /重试/);
  assert.ok(await page.locator('.msg .error, .error').count() >= 1, '仍要显示错误');

  const layout = await page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth}));
  assert.ok(layout.scrollWidth <= 390, '390×844 下不能横向溢出，实际 scrollWidth=' + layout.scrollWidth);
});
