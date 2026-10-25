import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

let chromium = null;
try { ({chromium} = await import('playwright')); } catch { /* 没有 playwright 时整组跳过 */ }

// 390 宽下的设置页：入站 MCP 区可见、可签发、一次性凭据与三种片段可读，且不横向溢出。
test('设置页 390 宽：入站 MCP 区可见、可签发、无横向溢出', async t => {
  if (!chromium) { console.log('跳过：未安装 playwright'); return; }
  let browser;
  try { browser = await chromium.launch({channel: 'msedge'}); }
  catch (error) {
    console.log('跳过：没有可用的 Edge/Chromium（' + error.message.split('\n')[0] + '）');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'zx-inbound-ui-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, {recursive: true, force: true}); });

  const reg = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name: 'alice', password: 'correct-horse-battery'})
  });
  assert.equal(reg.status, 200);
  const cookies = (reg.headers.getSetCookie?.() || [reg.headers.get('set-cookie')]).filter(Boolean).join('; ');
  const auth = /career_auth=([^;]+)/.exec(cookies)[1];
  const opened = await fetch(app.origin + '/api/mcp/switch', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie: 'career_auth=' + auth},
    body: JSON.stringify({enabled: true, confirm: true})
  });
  assert.equal(opened.status, 200);

  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  await context.addCookies([{name: 'career_auth', value: auth, domain: '127.0.0.1', path: '/'}]);
  const page = await context.newPage();
  await page.goto(app.origin + '/chat', {waitUntil: 'networkidle'});
  await page.click('#mobile-model');
  await page.waitForSelector('#inbound-mcp-section', {timeout: 10000});
  assert.equal((await page.textContent('#inbound-mcp-section h3')).trim(), '入站 MCP');
  assert.equal((await page.textContent('#inbound-mcp-section .state')).trim(), '已开启');
  assert.match(await page.textContent('#inbound-mcp-section'), /127\.0\.0\.1.*\/mcp/);

  await page.fill('#inbound-client-name', 'claude-code');
  await page.click('#inbound-mcp-section [data-act="issue"]');
  await page.waitForSelector('#inbound-mcp-section .inbound-reveal', {timeout: 10000});
  assert.match(await page.textContent('#inbound-mcp-section .inbound-tokenline code'), /^zxmcp_[a-f0-9]{48}$/);
  assert.equal(await page.locator('#inbound-mcp-section .inbound-snippets details').count(), 3);
  assert.equal(await page.locator('#inbound-mcp-section .inbound-client').count(), 1);

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    section: document.querySelector('#inbound-mcp-section').scrollWidth
  }));
  assert.equal(widths.document, widths.viewport, '文档不应横向溢出');
  assert.equal(widths.body, widths.viewport, 'body 不应横向溢出');
  assert.ok(widths.section <= widths.viewport, '入站 MCP 区不应撑破视口');
});
