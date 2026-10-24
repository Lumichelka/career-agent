// 浏览器兜底：站点用 JS 渲染或只给空壳时，用本机 Edge 打开再取可见文字。
// 只在源标记为 browser 且显式启用时使用，避免正常采集被拖慢。
import {chromium} from 'playwright';

export async function browserText(url, {timeout = 30000, waitMs = 2500} = {}) {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
  } catch (e) {
    throw new Error('浏览器模式不可用：未找到 Microsoft Edge，或 Playwright 组件缺失（' + String(e.message).slice(0, 120) + '）');
  }
  try {
    const context = await browser.newContext({locale: 'zh-CN', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', viewport: {width: 1366, height: 900}});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout});
    await page.waitForTimeout(waitMs);
    // 往下滚一点，触发懒加载列表
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    const title = await page.title();
    await context.close();
    return {text, title};
  } finally {
    await browser.close().catch(() => {});
  }
}

const DATE_RE = /(20\d{2})[-年.\/](\d{1,2})[-月.\/](\d{1,2})/;
const VENUE_RE = /([\u4e00-\u9fa5A-Za-z0-9]{2,18}(?:校区|楼|室|厅|馆|中心)[\u4e00-\u9fa5A-Za-z0-9]{0,20})/;
const TIME_RE = /(\d{1,2}):(\d{2})\s*[-~—至到]\s*(\d{1,2}):(\d{2})/;

// 从渲染后的纯文本里做保守抽取：宁可少抓，也不编造。
export function parseRenderedText(text, source) {
  const items = [];
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length < 8 || line.length > 160) continue;
    const m = line.match(DATE_RE);
    if (!m) continue;
    const date = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const time = line.match(TIME_RE);
    const title = line.replace(DATE_RE, '').replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '').replace(/[【】\[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 4) continue;
    const venue = (line.match(VENUE_RE) || [])[1] || '';
    items.push({
      title,
      company: '',
      startAt: `${date}T${time ? time[1].padStart(2, '0') : '09'}:${time ? time[2] : '00'}:00+08:00`,
      endAt: time ? `${date}T${time[3].padStart(2, '0')}:${time[4]}:00+08:00` : '',
      venue,
      city: source.city,
      url: source.listUrl,
      kind: source.kind || '其他',
      confidence: 0.45,
      notes: '浏览器渲染文本抽取，字段可能不全，请点开原链接核对'
    });
  }
  const seen = new Set();
  return items.filter(i => { const k = i.title + i.startAt; if (seen.has(k)) return false; seen.add(k); return true; });
}
