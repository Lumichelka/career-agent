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

async function saveModel(app, cookie, baseUrl) {
  const response = await fetch(app.origin + '/api/model/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify({mode: 'local', protocol: 'chat', baseUrl, model: 'mock-model', stream: true})
  });
  const body = await response.text();
  assert.equal(response.status, 200, '保存模型设置失败：' + body);
}

async function waitEnabled(page) {
  await page.waitForFunction(() => document.querySelector('#send')?.disabled === false, null, {timeout: 30000});
}

test('任务卡待确认区：脱敏预览、接受后写入并入审计且不可撤销、拒绝留记录', {timeout: 180000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-confirm-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-confirm');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');
  await saveModel(app, cookie, mock.url);

  async function sendMessage(text) {
    await waitEnabled(page);
    await page.evaluate(() => window.__workflow?.close());
    await page.fill('#input', text);
    await page.click('#send');
  }

  async function openDrawerAndFindConfirm() {
    await page.waitForFunction(() => Number(document.querySelector('#workflow-count')?.textContent || 0) >= 1, null, {timeout: 30000});
    await page.click('#workflow-toggle');
    await page.waitForSelector('#workflow-drawer .task-confirm', {state: 'visible', timeout: 15000});
    return page.locator('#workflow-drawer .task-card').filter({has: page.locator('.task-confirm')}).first();
  }

  // 第一轮：出现待确认区，脱敏预览 + 接受/拒绝；390 宽不溢出。
  await sendMessage('请写入长期画像');
  let card = await openDrawerAndFindConfirm();
  const confirmText = await card.locator('.task-confirm').innerText();
  assert.match(confirmText, /待确认/);
  assert.match(confirmText, /写入长期画像/);
  assert.match(confirmText, /城市偏好/);
  assert.match(confirmText, /成都/);
  assert.ok(!confirmText.includes('13800138000'), '待确认预览必须脱敏，实际：' + confirmText);
  assert.equal(await card.locator('.task-confirm button[data-confirm-action="accept"]').count(), 1);
  assert.equal(await card.locator('.task-confirm button[data-confirm-action="reject"]').count(), 1);
  assert.equal(await card.getAttribute('data-state'), 'waiting_confirmation');
  const layout = await page.evaluate(() => {
    const item = document.querySelector('#workflow-drawer .confirm-item');
    return {pageScroll: document.documentElement.scrollWidth, itemScroll: item ? item.scrollWidth : 0, itemClient: item ? item.clientWidth : 0, drawer: document.querySelector('#workflow-drawer').scrollWidth};
  });
  assert.ok(layout.pageScroll <= 390, '390×844 下整页不能横向溢出，实际 ' + layout.pageScroll);
  assert.ok(layout.itemScroll <= layout.itemClient + 1, '待确认项不能横向溢出');

  // 点击接受：待确认区消失，任务变成功，审计区出现不可撤销的确认记录。
  await card.locator('button[data-confirm-action="accept"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#workflow-drawer .task-confirm').length === 0, null, {timeout: 15000});
  await page.waitForFunction(() => [...document.querySelectorAll('#workflow-drawer .task-card')].some(item => item.dataset.state === 'succeeded'), null, {timeout: 15000});
  const acceptedCard = page.locator('#workflow-drawer .task-card').filter({has: page.locator('.task-audit')}).first();
  const acceptedText = await acceptedCard.locator('.task-audit').innerText();
  assert.match(acceptedText, /已接受/);
  assert.match(acceptedText, /写入已记入审计/);
  assert.match(acceptedText, /不可撤销/);
  assert.equal(await acceptedCard.locator('.task-audit button').count(), 0, '确认记录不提供撤销按钮');
  assert.match(await acceptedCard.innerText(), /自动写入 2 条/, '接受后任务卡显示写入条数');

  // 第二轮：拒绝只留记录，不显示已接受。
  await sendMessage('请写入第二条长期画像');
  card = await openDrawerAndFindConfirm();
  assert.match(await card.locator('.task-confirm').innerText(), /期望城市 2/);
  await card.locator('button[data-confirm-action="reject"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#workflow-drawer .task-confirm').length === 0, null, {timeout: 15000});
  const rejectedCard = page.locator('#workflow-drawer .task-card').filter({has: page.locator('.task-audit')}).first();
  const rejectedText = await rejectedCard.locator('.task-audit').innerText();
  assert.match(rejectedText, /已拒绝/);
  assert.match(rejectedText, /未写入/);
  assert.equal(await rejectedCard.locator('.task-audit button').count(), 0);
  assert.match(await rejectedCard.innerText(), /自动写入 0 条/, '拒绝不增加写入条数');
});
