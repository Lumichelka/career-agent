import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const EVENT = {
  title: '西南财经大学2026届秋季双选会',
  startAt: '2026-11-05T09:00:00+08:00',
  school: '西南财经大学',
  city: '成都',
  kind: '双选会',
  venue: '柳林校区体育馆'
};

// 浏览器不可用时明确跳过，绝不静默通过。本机装了 Microsoft Edge，优先用它。
async function launchBrowser(t, port) {
  // Playwright 会拒绝随机撞上的 Chromium 受限端口；显式放行本次实例端口。
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

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}

async function postJson(app, path, cookie, body, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 状态不符：' + JSON.stringify(payload));
  return payload;
}

async function getJson(app, path, cookie, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 失败：' + JSON.stringify(payload));
  return payload;
}

function openStore(app, userId) {
  return RecruitStore.open(join(app.dataDir, 'users', userId, '.data', 'recruit.db'));
}

test('审阅层：任务卡入口、批次 diff、强制撤销二次确认、390 无溢出、关闭回抽屉', {timeout: 240000}, async t => {
  const mock = await startMockOpenAI({delayMs: 100});
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-audit-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-audit');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');

  const saved = await postJson(app, '/api/model/save', cookie, {mode: 'local', protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true});
  assert.equal(saved.mode, 'local');
  await postJson(app, '/api/recruit/manual/save', cookie, {
    school: EVENT.school, city: EVENT.city, kind: EVENT.kind, title: EVENT.title, startAt: EVENT.startAt, venue: '旧场馆'
  });
  const me = await getJson(app, '/api/auth/me', cookie);

  async function noOverflow(label) {
    const layout = await page.evaluate(() => {
      const layer = document.querySelector('#audit-layer');
      const shell = document.querySelector('.audit-shell');
      const detail = document.querySelector('#audit-detail');
      return {
        page: document.documentElement.scrollWidth,
        layer: layer ? layer.scrollWidth : 0,
        shell: shell ? shell.scrollWidth : 0,
        detail: detail ? detail.scrollWidth : 0,
        detailClient: detail ? detail.clientWidth : 0
      };
    });
    assert.ok(layout.page <= 390, label + '：390×844 整页不能横向溢出，实际 ' + layout.page);
    assert.ok(layout.layer <= 390, label + '：审阅层不能横向溢出，实际 ' + layout.layer);
    assert.ok(layout.shell <= 390, label + '：审阅层面板不能横向溢出，实际 ' + layout.shell);
    assert.ok(layout.detail <= layout.detailClient + 1, label + '：diff 区不能横向溢出');
  }

  // 发一轮自动写入：任务卡上出现审阅入口。
  await page.waitForFunction(() => document.querySelector('#send')?.disabled === false, null, {timeout: 30000});
  await page.fill('#input', '请自动写入招聘活动');
  await page.click('#send');
  await page.waitForFunction(() => Number(document.querySelector('#workflow-count')?.textContent || 0) >= 1, null, {timeout: 30000});
  await page.click('#workflow-toggle');
  await page.waitForSelector('#workflow-drawer .task-card', {state: 'visible', timeout: 10000});
  await page.waitForFunction(() => [...document.querySelectorAll('#workflow-drawer .task-card')].some(card => card.dataset.state === 'succeeded'), null, {timeout: 60000});

  const card = page.locator('#workflow-drawer .task-card').first();
  const auditEntry = card.locator('[data-task-action="audit"]');
  const undoEntry = card.locator('[data-task-action="undo-task"]');
  assert.equal(await auditEntry.isDisabled(), false, '任务卡上「查看审计明细」应可用');
  assert.equal(await undoEntry.isDisabled(), false, '任务卡上「撤销本任务全部自动写入」应可用');
  assert.match(await card.locator('.task-undo').innerText(), /可撤销 2 条/, '任务卡显示后端给的撤销摘要');

  // 打开审阅层：手机先列表，点批次进详情，字段表 + 原始 JSON。
  await auditEntry.click();
  await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 10000});
  assert.match(await page.locator('#audit-scope').innerText(), /本任务/);
  await page.waitForSelector('#audit-batches .audit-batch', {timeout: 10000});
  assert.equal(await page.locator('#audit-layer.show-detail').count(), 0, '手机先显示列表');
  await noOverflow('列表');
  await page.locator('#audit-batches .audit-batch').first().click();
  await page.waitForSelector('#audit-layer.show-detail', {timeout: 10000});
  await page.waitForSelector('#audit-detail .audit-diff', {state: 'visible', timeout: 10000});
  assert.match(await page.locator('#audit-detail .audit-diff thead').first().innerText(), /字段[\s\S]*旧值[\s\S]*新值/);
  assert.ok(await page.locator('#audit-detail details.audit-raw').count() >= 1, '每行有可折叠原始 JSON');
  await noOverflow('详情');

  // 返回：先回列表，再关掉审阅层回到抽屉。
  await page.click('#audit-back');
  await page.waitForFunction(() => !document.querySelector('#audit-layer')?.classList.contains('show-detail'), null, {timeout: 10000});
  assert.equal(await page.locator('#audit-layer').isVisible(), true, '第一次返回只回到列表');
  await page.click('#audit-back');
  await page.waitForSelector('#audit-layer', {state: 'hidden', timeout: 10000});
  assert.equal(await page.locator('#workflow-drawer').isVisible(), true, '关闭审阅层后回到抽屉');
  assert.equal(await page.evaluate(() => document.body.classList.contains('workflow-open')), true);

  // 手工改掉活动行：撤销预检应报冲突，强制撤销弹窗展示当前值/写回值/后果，两个按钮。
  const store = openStore(app, me.user.id);
  try {
    store.db.prepare("UPDATE events SET title='我手工改过的标题', venue='我换的场馆' WHERE title=?").run(EVENT.title);
  } finally { store.close(); }

  await page.locator('#workflow-drawer .task-card').first().locator('[data-task-action="audit"]').click();
  await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 10000});
  await page.waitForSelector('[data-force-open]', {timeout: 10000});
  assert.match(await page.locator('#audit-conflict-bar').innerText(), /1 行已被手工修改/);
  await page.click('[data-force-open]');
  await page.waitForSelector('#audit-force-dialog[open]', {timeout: 10000});
  const dialog = page.locator('#audit-force-dialog');
  assert.equal(await dialog.locator('button').count(), 2, '强制确认必须只有两个按钮');
  const dialogText = await dialog.innerText();
  assert.match(dialogText, /当前值/);
  assert.match(dialogText, /写回值/);
  assert.match(dialogText, /后果/);
  assert.match(dialogText, /我手工改过的标题/);
  assert.match(dialogText, /取消/);
  assert.match(dialogText, /强制撤销并覆盖/);
  assert.doesNotMatch(dialogText, /输入/, '不要求输入确认短语');
  await noOverflow('强制确认');

  // 取消不改变数据；再次打开展开并强制撤销。
  await dialog.locator('[data-force-cancel]').click();
  await page.waitForFunction(() => !document.querySelector('#audit-force-dialog')?.open, null, {timeout: 10000});
  const unchanged = openStore(app, me.user.id);
  try { assert.equal(unchanged.getEvent(unchanged.db.prepare('SELECT id FROM events LIMIT 1').get().id).title, '我手工改过的标题'); }
  finally { unchanged.close(); }

  await page.click('[data-force-open]');
  await page.waitForSelector('#audit-force-dialog[open]', {timeout: 10000});
  await page.locator('[data-force-confirm]').click();
  await page.waitForFunction(() => (document.querySelector('#audit-summary')?.textContent || '').includes('已撤销 2'), null, {timeout: 20000});
  assert.match(await page.locator('#audit-summary').innerText(), /已撤销 2 \/ 冲突 1 \/ 失败 0/, '顶部汇总只渲染后端计数');
  await page.locator('#audit-batches .audit-batch').first().click();
  await page.waitForSelector('#audit-detail [data-result="forced"]', {state: 'visible', timeout: 10000});
  assert.match(await page.locator('#audit-detail [data-result="forced"]').first().innerText(), /强制撤销/);
  await noOverflow('强制撤销后');

  // 数据库回到写入前的值（手工修改被旧值覆盖）。
  const after = openStore(app, me.user.id);
  try {
    const event = after.db.prepare('SELECT * FROM events').get();
    assert.equal(event.title, EVENT.title, '强制撤销写回旧值');
    assert.equal(event.venue, '旧场馆');
    assert.equal(after.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 0, '无冲突行照常撤销');
  } finally { after.close(); }

  await page.click('#audit-close');
  await page.waitForSelector('#audit-layer', {state: 'hidden', timeout: 10000});
  assert.equal(await page.locator('#workflow-drawer').isVisible(), true);
  await page.waitForFunction(() => [...document.querySelectorAll('#workflow-drawer .task-card')].some(card => card.dataset.state === 'undone'), null, {timeout: 15000});
  const undoneCard = page.locator('#workflow-drawer .task-card').first();
  assert.match(await undoneCard.locator('.task-undo').innerText(), /已撤销全部/);
  assert.equal(await undoneCard.locator('[data-task-action="undo-task"]').isDisabled(), true, '撤销完不能再撤');

  // 顶部「全部审计」切换存在；不实现 #41 的筛选/导出/清空。
  await undoneCard.locator('[data-task-action="audit"]').click();
  await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 10000});
  assert.equal(await page.locator('#audit-layer button').filter({hasText: '导出'}).count(), 0);
  assert.equal(await page.locator('#audit-layer button').filter({hasText: '清空'}).count(), 0);
  await page.click('#audit-all-toggle');
  await page.waitForFunction(() => (document.querySelector('#audit-scope')?.textContent || '').includes('全部审计'), null, {timeout: 15000});
  assert.match(await page.locator('#audit-summary').innerText(), /全部审计/);
  await page.waitForSelector('#audit-batches .audit-batch', {timeout: 10000});
  await page.click('#audit-all-toggle');
  await page.waitForFunction(() => (document.querySelector('#audit-scope')?.textContent || '').includes('本任务'), null, {timeout: 15000});
  await page.click('#audit-close');
  await page.waitForSelector('#audit-layer', {state: 'hidden', timeout: 10000});
});
