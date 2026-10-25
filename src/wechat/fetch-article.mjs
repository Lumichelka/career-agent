// 公众号正文抓取：先走 HTTP，失败或正文过短时用本机 Edge 渲染；仍失败则交给粘贴正文。
import {fetchText} from '../recruit/fetch.mjs';
import {browserText} from '../recruit/browser.mjs';
import {parseArticleHtml} from '../recruit/manual.mjs';

function normalizeUrl(url) {
  try {
    const u = new URL(String(url).replace(/&amp;/g, '&'));
    if (!/mp\.weixin\.qq\.com$/.test(u.hostname)) return '';
    u.protocol = 'https:';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

export async function fetchWechatArticle(url) {
  const link = normalizeUrl(url);
  if (!link) return {ok: false, message: '不是有效的公众号文章链接', title: '', text: ''};
  let title = '', text = '', publishedAt = '';
  try {
    const res = await fetchText(link, {timeout: 20000, retries: 0, minInterval: 0, checkRobots: false});
    if (res.ok) {
      const parsed = parseArticleHtml(res.text);
      title = parsed.title || '';
      text = String(parsed.text || '');
      publishedAt = parsed.publishedAt || '';
    }
  } catch { /* 走浏览器 */ }
  if (text.trim().length < 120) {
    try {
      const rendered = await browserText(link, {timeout: 30000, waitMs: 3500});
      title = rendered.title || title;
      text = String(rendered.text || text);
    } catch { /* 保留 HTTP 结果 */ }
  }
  if (text.trim().length < 120) {
    return {ok: false, message: '微信要求验证或正文为空；请把推文正文粘贴进来', title, text: '', link};
  }
  return {ok: true, title: title || text.split('\n').map(s => s.trim()).find(Boolean) || '公众号文章', text, publishedAt, link};
}

export {normalizeUrl};
