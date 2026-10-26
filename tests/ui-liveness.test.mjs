import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function launchBrowser(t, port) {
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true, args}); } catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true, args}); } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

test('失联提示：90 秒无真实进度（心跳不算）标「可能失联」，任何真实事件清掉', {timeout: 120000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-liveness-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-liveness');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  await page.waitForSelector('#liveness-hint', {state: 'attached', timeout: 10000});

  // 登录后再装假时钟：之后的 setInterval / Date.now 都由测试推进。
  await page.clock.install({time: new Date('2026-10-26T10:00:00Z')});
  const dispatch = type => page.evaluate(eventType => {
    window.dispatchEvent(new CustomEvent('career:task', {detail: {type: eventType}}));
  }, type);
  const hintHidden = () => page.evaluate(() => document.getElementById('liveness-hint')?.hidden !== false);

  // 模拟一轮任务开始：停止按钮可见 + 收到一条真实进度事件。
  await page.evaluate(() => { document.querySelector('#stop').hidden = false; });
  await dispatch('status');
  assert.equal(await hintHidden(), true, '刚开始不提示失联');

  await page.clock.runFor(92000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await hintHidden(), false, '91 秒没有真实进度应标「可能失联」');
  assert.match(await page.locator('#liveness-hint').innerText(), /可能失联/);
  assert.match(await page.locator('#liveness-hint').innerText(), /90 秒/);

  // 任何真实事件都清掉提示。
  await dispatch('status');
  assert.equal(await hintHidden(), true, '真实事件立即清除失联提示');

  // 心跳不算进度：心跳之后仍然会失联。
  await dispatch('heartbeat');
  await page.clock.runFor(92000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await hintHidden(), false, '只有心跳时仍会标失联');

  // 任务没有被前端停掉；服务端也不会因为提示而杀任务。
  assert.equal(await page.evaluate(() => document.querySelector('#stop').hidden), false, '提示失联不会自动停止任务');
  assert.ok((await page.locator('body').evaluate(node => node.scrollWidth)) <= 390, '390 宽不横向溢出');
});
