import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {createWriteGateway} from '../src/writes/gateway.mjs';
import {summarizeTaskUndo} from '../src/writes/undo.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PHRASE = '清空我的审计';

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

function dbPath(app, userId) {
  return join(app.dataDir, 'users', userId, '.data', 'recruit.db');
}

// 任务 + 经写网关的审计：任务卡与全局审计都能看到同一批行，时间/发起者/工具可控。
async function seedTask(app, user, {title, actorType, actorRef, tool, at, changes}) {
  const outcome = await app.tasks.run({
    userId: user.id,
    sessionId: '',
    title,
    sourceName: '对话',
    describeUndo: ({task}) => summarizeTaskUndo({dir: join(app.dataDir, 'users', user.id, '.data'), userId: user.id, taskId: task.id}),
    execute: async ({task}) => {
      const store = RecruitStore.open(dbPath(app, user.id));
      try {
        const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId: user.id, taskId: task.id, actorType, actorRef, now: () => new Date(at)});
        await gateway.write({
          tool,
          payload: {title, at, changes},
          idempotencyKey: 'ui-' + task.id,
          sourceRef: {sourceId: 'manual'},
          execute: () => changes
        });
      } finally { store.close(); }
      return {reply: '完成'};
    }
  });
  assert.equal(outcome.task.state, 'succeeded');
  return outcome.task;
}

test('全局审计：筛选、导出 JSON/CSV、清空短语、390 无溢出、关闭回抽屉', {timeout: 240000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ui-audit-global-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(app.origin + '/chat');
  await page.waitForSelector('#account-name', {state: 'visible'});
  await page.fill('#account-name', 'ui-audit-global');
  await page.fill('#account-password', 'correct-horse-battery');
  await page.click('#account-register');
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  const cookie = (await context.cookies(app.origin)).map(item => item.name + '=' + item.value).join('; ');
  const meResponse = await fetch(app.origin + '/api/auth/me', {headers: {'x-career-token': app.token, cookie}});
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  const alice = {id: me.user.id};

  // 用测试进程直接建两个任务与审计，UI 只负责展示。
  const t1 = await seedTask(app, alice, {
    title: '一月写入任务', actorType: 'model', actorRef: 'api:mock', tool: 'career_recruit_bulk_write',
    at: '2026-01-05T10:00:00.000Z',
    changes: [
      {action: 'create', entity: 'events', entityId: 'ui-evt-jan', newValues: {id: 'ui-evt-jan', title: '一月活动'}},
      {action: 'create', entity: 'event_projects', entityId: 'ui-prj-jan', newValues: {id: 'ui-prj-jan', company: '一月单位'}}
    ]
  });
  const t2 = await seedTask(app, alice, {
    title: '二月外部 Agent 任务', actorType: 'agent', actorRef: 'mcp__review__write_events', tool: 'mcp__review__write_events',
    at: '2026-02-05T10:00:00.000Z',
    changes: [
      {action: 'update', entity: 'events', entityId: 'ui-evt-feb', oldValues: {id: 'ui-evt-feb', title: '旧标题'}, newValues: {id: 'ui-evt-feb', title: '二月活动'}}
    ]
  });

  async function noOverflow(label) {
    const layout = await page.evaluate(() => {
      const layer = document.querySelector('#audit-layer');
      const shell = document.querySelector('.audit-shell');
      const toolbar = document.querySelector('#audit-toolbar-slot');
      return {
        page: document.documentElement.scrollWidth,
        layer: layer ? layer.scrollWidth : 0,
        shell: shell ? shell.scrollWidth : 0,
        toolbar: toolbar ? toolbar.scrollWidth : 0
      };
    });
    assert.ok(layout.page <= 390, label + '：390×844 整页不能横向溢出，实际 ' + layout.page);
    assert.ok(layout.layer <= 390, label + '：审阅层不能横向溢出，实际 ' + layout.layer);
    assert.ok(layout.shell <= 390, label + '：审阅层面板不能横向溢出，实际 ' + layout.shell);
    assert.ok(layout.toolbar <= layout.shell, label + '：工具栏不能横向溢出');
  }

  // 抽屉 → 任务审阅层 → 全部审计。
  await page.click('#workflow-toggle');
  await page.waitForSelector('#workflow-drawer .task-card', {state: 'visible', timeout: 15000});
  await page.waitForFunction(() => document.querySelectorAll('#workflow-drawer .task-card').length === 2, null, {timeout: 15000});
  await page.locator('#workflow-drawer .task-card').first().locator('[data-task-action="audit"]').click();
  await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 10000});
  assert.equal(await page.locator('#audit-toolbar-slot .audit-toolbar').count(), 0, '任务视图不出现跨任务工具栏');
  await page.click('#audit-all-toggle');
  await page.waitForFunction(() => (document.querySelector('#audit-scope')?.textContent || '').includes('全部审计'), null, {timeout: 15000});
  await page.waitForSelector('#audit-toolbar-slot .audit-toolbar', {state: 'visible', timeout: 10000});
  await page.waitForSelector('#audit-batches .audit-batch', {timeout: 10000});
  assert.equal(await page.locator('#audit-batches .audit-batch').count(), 2, '跨任务视图看到两个批次');
  assert.match(await page.locator('#audit-toolbar-meta').innerText(), /共 2 个批次 \/ 3 行/);
  assert.match(await page.locator('#audit-toolbar-meta').innerText(), /清空需输入「清空我的审计」/);
  await noOverflow('全部审计');

  // 实体筛选：命中两个批次的两条 events；行数由后端给。
  await page.selectOption('#audit-filter-entity', 'events');
  await page.click('[data-audit-apply]');
  await page.waitForFunction(() => (document.querySelector('#audit-toolbar-meta')?.textContent || '').includes('已筛选'), null, {timeout: 10000});
  await page.waitForFunction(() => document.querySelectorAll('#audit-batches .audit-batch').length === 2, null, {timeout: 10000});
  assert.match(await page.locator('#audit-toolbar-meta').innerText(), /共 2 个批次 \/ 2 行/);
  assert.match(await page.locator('#audit-summary').innerText(), /全部审计 · 2 个批次 \/ 2 行/);
  await noOverflow('筛选后');

  // 任务筛选：只留第二个任务。
  await page.click('[data-audit-reset]');
  await page.waitForFunction(() => document.querySelectorAll('#audit-batches .audit-batch').length === 2, null, {timeout: 10000});
  await page.fill('#audit-filter-task', t2.id);
  await page.click('[data-audit-apply]');
  await page.waitForFunction(() => document.querySelectorAll('#audit-batches .audit-batch').length === 1, null, {timeout: 10000});
  assert.match(await page.locator('#audit-toolbar-meta').innerText(), /共 1 个批次 \/ 1 行/);
  assert.match(await page.locator('#audit-batches .audit-batch').first().innerText(), /外部 Agent|mcp__review__write_events|二月/);

  // 导出 JSON：服务端生成，下载内容与当前筛选一致。
  const jsonDownload = page.waitForEvent('download');
  await page.click('[data-audit-export="json"]');
  const downloadedJson = await jsonDownload;
  assert.match(downloadedJson.suggestedFilename(), /^career-audit-\d{14}\.json$/);
  const jsonBody = JSON.parse(await readFile(await downloadedJson.path(), 'utf8'));
  assert.equal(jsonBody.counts.rows, 1);
  assert.equal(jsonBody.batches[0].taskId, t2.id);
  assert.equal(jsonBody.filters.taskId, t2.id);
  assert.equal(jsonBody.batches[0].rows[0].oldValues.title, '旧标题');
  assert.equal(jsonBody.batches[0].rows[0].newValues.title, '二月活动');

  // 导出 CSV：同样的筛选，文件名与服务端计数。
  const csvDownload = page.waitForEvent('download');
  await page.click('[data-audit-export="csv"]');
  const downloadedCsv = await csvDownload;
  assert.match(downloadedCsv.suggestedFilename(), /^career-audit-\d{14}\.csv$/);
  const csvText = await readFile(await downloadedCsv.path(), 'utf8');
  assert.equal(csvText.replace(/^\uFEFF/, '').trim().split(/\r?\n/).length, 2);
  assert.match(csvText, /ui-evt-feb/);

  // 清空：必须原样输入短语；按钮在短语匹配前不可用。
  await page.click('[data-audit-clear-open]');
  await page.waitForSelector('#audit-clear-dialog[open]', {timeout: 10000});
  const clearConfirm = page.locator('[data-clear-confirm]');
  assert.equal(await clearConfirm.isDisabled(), true, '未输入短语时不能清空');
  assert.match(await page.locator('#audit-clear-dialog').innerText(), /清空我的审计/);
  await page.fill('#audit-clear-phrase', '清空');
  assert.equal(await clearConfirm.isDisabled(), true, '短语不完整时不能清空');
  await page.fill('#audit-clear-phrase', PHRASE);
  assert.equal(await clearConfirm.isDisabled(), false);
  await noOverflow('清空弹窗');
  await clearConfirm.click();
  await page.waitForFunction(() => !document.querySelector('#audit-clear-dialog')?.open, null, {timeout: 15000});
  await page.waitForFunction(() => (document.querySelector('#audit-summary')?.textContent || '').includes('已清空'), null, {timeout: 15000});
  assert.match(await page.locator('#audit-summary').innerText(), /已清空 3 条审计、0 条确认记录/);
  await page.waitForSelector('#audit-batches .audit-empty', {timeout: 10000});
  assert.equal(await page.locator('#audit-batches .audit-batch').count(), 0);
  await page.waitForFunction(() => (document.querySelector('#audit-toolbar-meta')?.textContent || '').includes('上次清空'), null, {timeout: 10000});
  await noOverflow('清空后');

  // 关闭回到抽屉，对话框不残留。
  await page.click('#audit-close');
  await page.waitForSelector('#audit-layer', {state: 'hidden', timeout: 10000});
  assert.equal(await page.locator('#workflow-drawer').isVisible(), true, '关闭审阅层后回到抽屉');
  assert.equal(await page.evaluate(() => document.querySelector('#audit-clear-dialog')?.open === true), false);

  // 后端确认：审计为空，last_cleared_at 已写。
  const auditResponse = await fetch(app.origin + '/api/audit', {headers: {'x-career-token': app.token, cookie}});
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert.equal(audit.batches.length, 0);
  assert.match(String(audit.lastClearedAt), /^\d{4}-\d{2}-\d{2}T/);
});
