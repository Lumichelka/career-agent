import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

let chromium = null;
try { ({chromium} = await import('playwright')); } catch { /* 没有 playwright 时整组跳过 */ }

// 假连接：UI 测试也绝不启动真实外部 Agent 或联网。
function fakeFactory() {
  const factory = async () => ({
    pid: null,
    era: () => 'modern',
    serverInfo: () => ({name: 'fake-mcp', version: '1.0.0'}),
    connect: async () => {},
    listTools: async () => ({tools: [
      {name: 'search_events', title: '搜索活动', annotations: {readOnlyHint: true}},
      {name: 'publish_note'}
    ]}),
    callTool: async () => ({content: []}),
    close: async () => {}
  });
  factory.calls = 0;
  return factory;
}

async function launchBrowser(t, port) {
  if (!chromium) { console.log('跳过：未安装 playwright'); return null; }
  const args = port ? ['--explicitly-allowed-ports=' + port] : [];
  let firstError = '';
  try { return await chromium.launch({channel: 'msedge', headless: true, args}); } catch (error) { firstError = error.message; }
  try { return await chromium.launch({headless: true, args}); } catch (error) {
    t.skip('Playwright 没有可用浏览器：Microsoft Edge 与内置 Chromium 都启动失败（' + firstError + ' / ' + error.message + '）');
    return null;
  }
}

async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-agents-ui-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, agentClientFactory: fakeFactory()});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, ...(cookie ? {cookie} : {})};
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {method: 'POST', headers: headers(app, ''), body: JSON.stringify({name, password: 'correct-horse-battery'})});
  const payload = await response.json();
  assert.equal(response.status, 200, '注册失败：' + JSON.stringify(payload));
  const raw = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).join('; ');
  return {cookie: raw, value: /career_auth=([^;]+)/.exec(raw)?.[1] || '', user: payload.user};
}

async function openChat(browser, app, auth, size) {
  const context = await browser.newContext({viewport: size});
  await context.addCookies([{name: 'career_auth', value: auth.value, domain: '127.0.0.1', path: '/'}]);
  const page = await context.newPage();
  await page.goto(app.origin + '/chat', {waitUntil: 'networkidle'});
  await page.waitForFunction(() => document.querySelector('#account-screen')?.style.display === 'none', null, {timeout: 15000});
  return {context, page};
}

async function createAgent(app, cookie, overrides = {}) {
  const response = await fetch(app.origin + '/api/agents', {method: 'POST', headers: headers(app, cookie), body: JSON.stringify({name: 'Dify 助手', transport: 'http', url: 'https://dify.example.com/mcp', token: 'sk-ui-secret', ...overrides})});
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.agent;
}

async function ownerAuth(app) {
  const text = await readFile(join(app.dataDir, '首次登录.txt'), 'utf8');
  const password = text.match(/密码：(.+)/)?.[1]?.trim();
  assert.ok(password);
  const response = await fetch(app.origin + '/api/auth/login', {method: 'POST', headers: headers(app, ''), body: JSON.stringify({name: 'owner', password})});
  const payload = await response.json();
  assert.equal(response.status, 200, 'owner 登录失败：' + JSON.stringify(payload));
  const raw = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).join('; ');
  return {cookie: raw, value: /career_auth=([^;]+)/.exec(raw)?.[1] || '', user: payload.user};
}

test('外部 Agent 页签：桌面两栏、添加/测试连接、工具只读写标记与入站区兼容', {timeout: 180000}, async t => {
  const app = await startApp(t);
  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const owner = await ownerAuth(app);
  const {page} = await openChat(browser, app, owner, {width: 1280, height: 900});

  await page.click('#model-settings');
  await page.waitForSelector('#settings-tab-bar', {timeout: 10000});
  assert.deepEqual(await page.locator('#settings-tab-bar button').allInnerTexts(), ['模型与接口', '外部 Agent']);
  assert.equal(await page.locator('#ms-form').isVisible(), true, '默认停留在模型页签');
  assert.equal(await page.locator('#inbound-mcp-section').count(), 1, '#37 的入站 MCP 区仍挂载');

  await page.click('#settings-tab-bar [data-settings-tab="agents"]');
  await page.waitForSelector('#agents-tab-panel:not([hidden])', {timeout: 10000});
  await assert.doesNotReject(page.waitForSelector('#agents-tab-panel .agents-empty', {timeout: 10000}));
  assert.equal(await page.locator('#inbound-mcp-section').isVisible(), false, '外部 Agent 页签不显示入站区');

  await page.click('#agents-tab-panel [data-act="add"]');
  assert.equal(await page.locator('#agents-tab-panel input[name="agents-transport"][value="stdio"]').count(), 1, 'owner 看得到 stdio');
  await page.fill('#agents-name', 'Dify 助手');
  await page.click('#agents-tab-panel input[name="agents-transport"][value="http"]');
  await page.waitForSelector('#agents-url');
  await page.fill('#agents-url', 'https://dify.example.com/mcp');
  await page.fill('#agents-token', 'sk-ui-secret');
  await page.click('#agents-tab-panel [data-act="save"]');
  await page.waitForFunction(() => (document.querySelectorAll('#agents-tab-panel .agents-row').length === 1) && !document.querySelector('#agents-tab-panel .agents-detail-pane .agents-form'), null, {timeout: 15000});
  assert.equal(await page.locator('#agents-tab-panel .agents-row').count(), 1);
  assert.doesNotMatch(await page.textContent('#agents-tab-panel'), /sk-ui-secret/, '凭据不回显');

  // 状态与工具：测试连接只连接 + 发现，工具带只读 / 写标记。
  await page.click('#agents-tab-panel [data-subtab="config"]');
  await page.click('#agents-tab-panel [data-act="test"]');
  await page.waitForFunction(() => /连接成功/.test(document.querySelector('#agents-feedback')?.textContent || ''), null, {timeout: 15000});
  await page.click('#agents-tab-panel [data-subtab="status"]');
  await page.waitForSelector('#agents-tab-panel .agents-card');
  assert.match(await page.textContent('#agents-tab-panel .agents-card'), /已连接 · modern/);
  assert.match(await page.textContent('#agents-tab-panel .agents-card'), /fake-mcp/);
  const tools = await page.locator('#agents-tab-panel .agents-tool').allInnerTexts();
  assert.equal(tools.length, 2);
  assert.match(tools[0], /search_events/);
  assert.match(tools[0], /只读/);
  assert.match(tools[1], /publish_note/);
  assert.match(tools[1], /写/);

  // 桌面两栏：列表约 1/3、详情约 2/3。
  const listBox = await page.locator('#agents-tab-panel .agents-list-pane').boundingBox();
  const detailBox = await page.locator('#agents-tab-panel .agents-detail-pane').boundingBox();
  assert.ok(listBox && detailBox);
  assert.ok(listBox.width > 100 && detailBox.width > listBox.width * 1.4, '详情应明显宽于列表：' + JSON.stringify({listBox, detailBox}));
  assert.equal(Math.abs(listBox.y - detailBox.y) < 4, true, '桌面两栏并排');

  // 切回模型页签：表单与入站区都回来，#37 不受影响。
  await page.click('#settings-tab-bar [data-settings-tab="model"]');
  assert.equal(await page.locator('#ms-form').isVisible(), true);
  assert.equal(await page.locator('#inbound-mcp-section').isVisible(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#inbound-mcp-section h3')?.textContent.trim()), '入站 MCP');

  // 关掉再打开：页签与入站区都只挂一次，配置还在。
  await page.click('#close');
  await page.click('#model-settings');
  await page.waitForSelector('#settings-tab-bar');
  assert.equal(await page.locator('#settings-tab-bar').count(), 1);
  assert.equal(await page.locator('#inbound-mcp-section').count(), 1);
  await page.click('#settings-tab-bar [data-settings-tab="agents"]');
  await page.waitForSelector('#agents-tab-panel .agents-row');
  assert.equal(await page.locator('#agents-tab-panel .agents-row').count(), 1);
});

test('外部 Agent 页签：非 owner 看不到 stdio；手机 390 列表 → 详情两屏无横向溢出', {timeout: 180000}, async t => {
  const app = await startApp(t);
  const browser = await launchBrowser(t, app.port);
  if (!browser) return;
  t.after(() => browser.close());
  const member = await register(app, 'alice');
  const agent = await createAgent(app, member.cookie, {name: '成员 HTTP Agent'});
  const {page} = await openChat(browser, app, member, {width: 390, height: 844});

  await page.click('#mobile-model');
  await page.waitForSelector('#settings-tab-bar', {timeout: 10000});
  await page.click('#settings-tab-bar [data-settings-tab="agents"]');
  await page.waitForSelector('#agents-tab-panel:not([hidden])');
  await page.waitForSelector('#agents-tab-panel .agents-row');
  assert.equal(await page.locator('#agents-tab-panel input[name="agents-transport"][value="stdio"]').count(), 0, '成员没有 stdio 选项');
  assert.match(await page.textContent('#agents-tab-panel'), /成员只能配置 HTTP/);

  // 手机默认全屏列表；点进详情后隐藏列表。
  assert.equal(await page.locator('#agents-tab-panel .agents-list-pane').isVisible(), true);
  assert.equal(await page.locator('#agents-tab-panel .agents-detail-pane').isVisible(), false);
  let widths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: window.innerWidth}));
  assert.equal(widths.document, 390, '列表屏不横向溢出');
  assert.equal(widths.body, 390);

  await page.click('#agents-tab-panel .agents-row[data-agent-id="' + agent.id + '"]');
  await page.waitForSelector('#agents-tab-panel .agents-back', {state: 'visible'});
  assert.equal(await page.locator('#agents-tab-panel .agents-list-pane').isVisible(), false);
  assert.equal(await page.locator('#agents-tab-panel .agents-detail-pane').isVisible(), true);
  assert.match(await page.textContent('#agents-tab-panel .agents-detail-head'), /成员 HTTP Agent/);
  widths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, body: document.body.scrollWidth}));
  assert.equal(widths.document, 390, '详情屏不横向溢出');
  assert.equal(widths.body, 390);

  await page.click('#agents-tab-panel [data-subtab="config"]');
  assert.equal(await page.locator('#agents-url').isVisible(), true);
  assert.match(await page.getAttribute('#agents-token', 'placeholder'), /已保存/);
  widths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, body: document.body.scrollWidth}));
  assert.equal(widths.document, 390, '配置屏不横向溢出');
  assert.equal(widths.body, 390);

  await page.click('#agents-tab-panel [data-act="back"]');
  await page.waitForFunction(() => document.querySelector('#agents-tab-panel .agents-list-pane')?.offsetParent !== null);
  assert.equal(await page.locator('#agents-tab-panel .agents-back').isVisible(), false, '列表屏没有返回按钮');

  // 对话框在手机上是全屏。
  const dialog = await page.locator('#dialog').boundingBox();
  assert.ok(dialog.width >= 389 && dialog.height >= 700, '手机设置页全屏：' + JSON.stringify(dialog));
});
