// 来源校对的应用内浏览器读取：只打开来源列表与一场活动详情各一次，各截一张图。
// 不启用 stealth / 反检测参数，不伪装 UA/指纹；不翻页、不并发、不绕过登录或验证码。
import {chromium} from 'playwright';
import {join} from 'node:path';

// 启动与上下文参数是公开契约：测试据此断言没有 stealth 与 UA 伪装。
export const BROWSER_LAUNCH_OPTIONS = {channel: 'msedge', headless: true};
export const BROWSER_CONTEXT_OPTIONS = {locale: 'zh-CN', viewport: {width: 1366, height: 900}};

const BLOCK_URL = /\/(login|signin|passport|sso|captcha|verify|auth)(\b|[/?#])/i;
const BLOCK_TEXT = /(请输入验证码|验证码|安全验证|人机验证|访问过于频繁|访问受限|403\s*Forbidden|Access\s*Denied|captcha)/i;

export class SourceCheckBlockedError extends Error {
  constructor(reasonOrInfo = {}, code, recovery) {
    const info = typeof reasonOrInfo === 'string' ? {reason: reasonOrInfo, code, recovery} : (reasonOrInfo || {});
    super(String(info.reason || '来源页需要登录或验证，已停止读取。').slice(0, 500));
    this.name = 'SourceCheckBlockedError';
    this.code = String(info.code || 'SOURCE_BLOCKED').slice(0, 60);
    this.reason = this.message;
    this.recovery = String(info.recovery || '改用公众号文章转发或手动导入；不要绕过登录或验证码。').slice(0, 300);
  }
}

export class SourceCheckError extends Error {
  constructor(code, message, recovery = '') {
    super(message);
    this.name = 'SourceCheckError';
    this.code = code;
    if (recovery) this.recovery = recovery;
  }
}

// 登录跳转、验证码/人机验证、明确的访问限制都算阻断：停下并给建议，不尝试绕过。
export function detectBlock({url = '', title = '', text = ''} = {}) {
  if (BLOCK_URL.test(String(url))) {
    return {blocked: true, code: 'SOURCE_LOGIN_REQUIRED', reason: '页面跳转到了登录/验证页：' + String(url).slice(0, 300), recovery: '改用公众号文章转发或手动导入；不要在自动流程里登录或绕过验证。'};
  }
  const haystack = (String(title) + '\n' + String(text)).slice(0, 20000);
  if (BLOCK_TEXT.test(haystack)) {
    return {blocked: true, code: 'SOURCE_BLOCKED', reason: '页面出现验证码、登录或访问限制提示，已停止读取。', recovery: '改用公众号文章转发或手动导入；稍后也可在普通浏览器里人工打开核对。'};
  }
  return {blocked: false};
}

function abortError() {
  const error = new Error('本次任务已停止。');
  error.name = 'AbortError';
  error.code = 'CANCELLED';
  return error;
}

async function openBrowser() {
  try {
    return await chromium.launch(BROWSER_LAUNCH_OPTIONS);
  } catch (error) {
    throw new SourceCheckError('BROWSER_UNAVAILABLE', '应用内浏览器不可用：未找到 Microsoft Edge 或 Playwright 组件缺失（' + String(error.message).slice(0, 120) + '）。', '安装 Microsoft Edge 后重试，或改用手动导入。');
  }
}

async function readPage(page, url, {signal, textLimit = 8000} = {}) {
  if (signal?.aborted) throw abortError();
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45000});
  // 页内滚动允许：等懒加载内容出现，始终停留在同一页，不翻页。
  await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(200);
  const title = await page.title().catch(() => '');
  const text = await page.evaluate(limit => String(document.body?.innerText || '').slice(0, limit), textLimit).catch(() => '');
  const finalUrl = page.url();
  const block = detectBlock({url: finalUrl, title, text});
  if (block.blocked) throw new SourceCheckBlockedError(block);
  return {url: finalUrl, title, text};
}

// 默认读取器：Playwright + 本机 Edge，列表 1 次 + 详情 1 次，各截图一次。
export async function readSourcePages({source, evidenceDir, signal} = {}) {
  if (!source?.listUrl) throw new SourceCheckError('INVALID_SOURCE', '这个来源没有可读取的列表地址。', '改用手动导入。');
  const browser = await openBrowser();
  try {
    const context = await browser.newContext(BROWSER_CONTEXT_OPTIONS);
    const page = await context.newPage();
    const listFile = join(evidenceDir, '01-list.png');
    const detailFile = join(evidenceDir, '02-detail.png');

    const list = await readPage(page, source.listUrl, {signal});
    await page.screenshot({path: listFile});
    const listAt = new Date().toISOString();

    const detailHref = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href]')];
      const hit = links.find(link => /jobfair-show-\d+\.htm/i.test(link.getAttribute('href') || '') || /jobfair-show-\d+\.htm/i.test(link.href || ''));
      return hit ? hit.href : '';
    }).catch(() => '');
    if (!detailHref) {
      throw new SourceCheckError('SOURCE_NO_DETAIL', '列表页没有找到可打开的活动详情链接，已停止，未写入任何数据。', '在普通浏览器人工打开活动后手动导入。');
    }

    const detail = await readPage(page, detailHref, {signal});
    await page.screenshot({path: detailFile});
    const detailAt = new Date().toISOString();

    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: listFile, url: list.url, title: list.title || source.name || '来源列表', at: listAt, viewport: {...BROWSER_CONTEXT_OPTIONS.viewport}},
        {id: 'detail', kind: 'screenshot', file: detailFile, url: detail.url, title: detail.title || '活动详情', at: detailAt, viewport: {...BROWSER_CONTEXT_OPTIONS.viewport}}
      ]
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
