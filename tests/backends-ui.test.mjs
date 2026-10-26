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
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function launchBrowser(t, port) {
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true, args}); } catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true, args}); } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

async function saveModel(app, cookie, baseUrl) {
  const response = await fetch(app.origin + '/api/model/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify({preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl, model: 'deepseek-flash', apiKey: 'sk-ui-test', stream: true})
  });
  assert.equal(response.status, 200, '保存模型设置失败：' + await response.text());
}

test('模型选路 UI：顶栏常驻、候选卡、调用表与 390 无横向溢出', {timeout: 180000}, async t => {
  const mock = await startMockOpenAI();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-backends-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const browser = await launchBrowser(t, app.port);
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

  await saveModel(app, cookie, mock.url);
  // 当前换成无视觉的 Codex，带图任务就会停下来出候选卡。
  const selected = await fetch(app.origin + '/api/backends/select', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie},
    body: JSON.stringify({kind: 'codex'})
  });
  assert.equal(selected.status, 200, '选择 Codex 失败：' + await selected.text());

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  await page.waitForSelector('#backend-bar', {state: 'visible'});
  const bar = await page.locator('#backend-bar').innerText();
  assert.match(bar, /当前/, '顶栏显示当前后端');
  assert.match(bar, /模型 API/, '顶栏有模型 API 入口');
  assert.match(bar, /外部 Agent/, '顶栏有外部 Agent 第二入口');
  assert.equal(await page.locator('#bb-mode-api').count(), 1);
  assert.equal(await page.locator('#bb-mode-agent').count(), 1);
  assert.match(bar, /本轮/, '顶栏显示本轮预估费用');
  assert.match(bar, /本次锁定/, '顶栏有本次锁定');

  // 上传截图 → 发送 → 当前 Codex 无视觉，出现候选卡。
  await page.setInputFiles('#files', {name: '双选会截图.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64')});
  await page.waitForFunction(() => (document.querySelector('#attachments')?.textContent || '').includes('双选会截图.png'));
  await page.fill('#input', '看看这张双选会截图，帮我整理活动和参会单位');
  await page.click('#send');
  await page.waitForSelector('.candidate-cards', {state: 'visible', timeout: 30000});
  assert.match(await page.locator('.candidate-cards').innerText(), /视觉|候选|后端/);
  const apiCard = page.locator('.candidate-card[data-backend-kind="api"]');
  assert.ok(await apiCard.count() >= 1, '候选卡里应有视觉 API');
  assert.equal(await apiCard.first().getAttribute('data-configured'), 'true');
  assert.match(await apiCard.first().innerText(), /约 ≈¥/);

  // 点一张卡 = 设为当前并开始本轮。
  const consoleLines = [];
  page.on('console', message => consoleLines.push(message.type() + ': ' + message.text()));
  page.on('pageerror', error => consoleLines.push('pageerror: ' + error.message));
  await apiCard.first().click();
  try {
    await page.waitForSelector('.msg.assistant .calls', {state: 'visible', timeout: 45000});
  } catch (error) {
    const debug = await page.evaluate(() => ({
      stopHidden: document.querySelector('#stop')?.hidden,
      input: document.querySelector('#input')?.value,
      bb: document.querySelector('#bb-current')?.textContent,
      status: document.querySelector('#status')?.textContent,
      errors: [...document.querySelectorAll('.error')].map(node => node.textContent),
      messages: document.querySelector('#messages')?.innerText.slice(-1500),
      cards: [...document.querySelectorAll('.candidate-card')].map(node => node.dataset.backendKind + ':' + node.dataset.configured)
    })).catch(problem => ({evaluateFailed: problem.message}));
    let session = '';
    try {
      const listed = await (await fetch(app.origin + '/api/sessions', {headers: {'x-career-token': app.token, cookie}})).json();
      if (listed.sessions.length) {
        const full = await (await fetch(app.origin + '/api/session/' + listed.sessions[0].id, {headers: {'x-career-token': app.token, cookie}})).json();
        session = JSON.stringify(full.messages.map(message => ({role: message.role, calls: message.calls?.length, text: String(message.content).slice(0, 120), error: message.error})));
      }
    } catch (problem) { session = '读取会话失败: ' + problem.message; }
    throw new Error('候选卡点击后没有出现调用表：' + JSON.stringify(debug) + '；会话=' + session + '；日志=' + consoleLines.slice(-12).join(' | '));
  }
  assert.match(await page.locator('#bb-current').innerText(), /API/, '点卡后顶栏切到 API 后端');
  const callSummary = await page.locator('.msg.assistant .calls summary').last().innerText();
  assert.match(callSummary, /本次调用（3 次/);
  assert.match(callSummary, /≈¥/);
  assert.match(callSummary, /tok/);

  await page.locator('.msg.assistant .calls summary').last().click();
  const table = page.locator('.msg.assistant .calls table').last();
  await table.waitFor({state: 'visible'});
  const headers = await table.locator('th').allInnerTexts();
  assert.deepEqual(headers, ['步骤', '后端', '耗时', '输入·输出', '≈¥', '备注']);
  const rows = await table.locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 3);
  assert.match(rows[0], /规划/);
  assert.match(rows[1], /执行/);
  assert.match(rows[2], /复核/);

  // 顶栏本轮费用在成功后变成估算金额。
  assert.match(await page.locator('#bb-cost').innerText(), /本轮 ≈¥/);

  // 降级展示：没回 usage 显示「未回传」；价表没型号只给 tokens，不给金额。
  const degraded = await page.evaluate(() => ({
    missing: window.__zxCallsHtml([{step: 'act', backend: {kind: 'api', label: 'API · Kimi'}, durationMs: 1200, outcome: 'ok'}], false),
    unknownPrice: window.__zxCallsHtml([{step: 'act', backend: {kind: 'api', label: 'API · Kimi'}, durationMs: 900, outcome: 'ok', usage: {input: 10, output: 2, total: 12}}], false)
  }));
  assert.match(degraded.missing, /未回传/);
  assert.doesNotMatch(degraded.missing, /≈¥\d/);
  assert.match(degraded.unknownPrice, /tok/);
  assert.doesNotMatch(degraded.unknownPrice, /≈¥\d/, '未知价不能显示金额');

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    callsWidth: document.querySelector('.msg.assistant .calls')?.getBoundingClientRect().width || 0
  }));
  assert.ok(layout.scrollWidth <= 390, '390×844 下不能横向溢出，实际 scrollWidth=' + layout.scrollWidth);
  assert.ok(layout.clientWidth <= 390);
  assert.ok(layout.callsWidth > 0 && layout.callsWidth <= 390, '调用表不能撑破视口');

  // 锁定开关写进本轮请求：锁上后再次发送，助手消息仍应带「本次锁定」标记。
  await page.click('#turn-lock');
  assert.equal(await page.getAttribute('#turn-lock', 'aria-pressed'), 'true');
  await page.fill('#input', '这一轮锁定后端');
  await page.click('#send');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .calls')].some(node => node.textContent.includes('本次锁定')), null, {timeout: 45000});
});
