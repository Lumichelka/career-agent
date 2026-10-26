import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {createWriteGateway} from '../src/writes/gateway.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const THRESHOLD = 2000;
const TASK_ID = '11111111-1111-4111-8111-111111111111';

async function launchBrowser(t, port) {
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true, args}); } catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true, args}); } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}
function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}
function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}
async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST', headers: headers(app, ''),
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  const body = await response.json();
  assert.equal(response.status, 200, name + ' 注册失败：' + JSON.stringify(body));
  return {user: body.user, cookie: cookieOf(response)};
}
async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  return {status: response.status, body: await response.json()};
}

// 直接经写网关造 2000 行审计：与自动写入走同一条路径，不是塞假表。
async function seedAuditRows(app, user, count) {
  const store = RecruitStore.open(join(app.dataDir, 'users', user.id, '.data', 'recruit.db'));
  try {
    const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: user.id, actorType: 'model', actorRef: 'api:bulk', taskId: TASK_ID});
    const changes = Array.from({length: count}, (_, index) => ({
      action: 'create',
      entity: 'events',
      entityId: 'bulk-' + index,
      newValues: {id: 'bulk-' + index, title: '批量活动 ' + index}
    }));
    await gateway.write({
      tool: 'career_recruit_bulk_write',
      payload: {count},
      idempotencyKey: 'audit-volume-' + count,
      sourceRef: 'bulk-test',
      execute: () => changes
    });
  } finally {
    store.close();
  }
}

test('审计体量提示：达到 2000 行时接口与全局审计界面都提示「导出后清空」', {timeout: 240000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-audit-volume-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const member = await register(app, 'audit-volume-user');

  // 还没写过：不提示。
  const empty = await getJson(app, '/api/audit', member.cookie);
  assert.equal(empty.body.volume.rows, 0);
  assert.equal(empty.body.volume.threshold, THRESHOLD);
  assert.equal(empty.body.volume.shouldPrompt, false);
  assert.equal(empty.body.volume.hint, '');

  await seedAuditRows(app, member.user, THRESHOLD + 1);

  const view = await getJson(app, '/api/audit?limit=50', member.cookie);
  assert.equal(view.body.volume.rows, THRESHOLD + 1);
  assert.equal(view.body.volume.shouldPrompt, true);
  assert.equal(view.body.volume.hint, '审计已 ' + (THRESHOLD + 1) + ' 条，建议导出后清空');
  assert.equal(view.body.counts.rows, THRESHOLD + 1, '总行数仍然由后端给');

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'audit-volume-user');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});

  await page.evaluate(() => window.__audit.openAll());
  await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 10000});
  await page.waitForSelector('#audit-volume-hint:not([hidden])', {timeout: 15000});
  assert.equal(await page.locator('#audit-volume-hint').innerText(), '审计已 ' + (THRESHOLD + 1) + ' 条，建议导出后清空');
  assert.equal(await page.locator('[data-audit-export="json"]').isVisible(), true, '提示旁有导出动作');
  assert.equal(await page.locator('[data-audit-export="csv"]').isVisible(), true);
  assert.equal(await page.locator('[data-audit-clear-open]').isVisible(), true, '提示旁有清空动作');
  assert.ok((await page.locator('body').evaluate(node => node.scrollWidth)) <= 390, '390 宽不横向溢出');
});
