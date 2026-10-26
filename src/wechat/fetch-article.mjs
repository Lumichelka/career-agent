// 公众号正文抓取：先走 HTTP，失败或正文过短时用本机 Edge 渲染；仍失败则交给粘贴正文。
// 同时带回公众号昵称与 biz，供文章自动归属使用。
import {fetchText} from '../recruit/fetch.mjs';
import {browserText} from '../recruit/browser.mjs';
import {parseArticleHtml} from '../recruit/manual.mjs';
import {bizOf, canonicalArticleUrl, parseWechatMeta} from './identity.mjs';

function normalizeUrl(url) {
  const link = canonicalArticleUrl(url);
  if (!link) return '';
  try {
    const u = new URL(link);
    return u.hostname === 'mp.weixin.qq.com' ? u.href : '';
  } catch { return ''; }
}

export async function fetchWechatArticle(url) {
  const link = normalizeUrl(url);
  if (!link) return {ok: false, message: '不是有效的公众号文章链接', title: '', text: '', nickname: '', biz: ''};
  let title = '', text = '', publishedAt = '', nickname = '', biz = bizOf(link);
  try {
    const res = await fetchText(link, {timeout: 20000, retries: 0, minInterval: 0, checkRobots: false});
    if (res.ok) {
      const parsed = parseArticleHtml(res.text);
      const meta = parseWechatMeta(res.text, link);
      title = parsed.title || meta.title || '';
      text = String(parsed.text || '');
      publishedAt = parsed.publishedAt || meta.publishedAt || '';
      nickname = meta.nickname || '';
      biz = meta.biz || biz;
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
    return {ok: false, message: '微信要求验证或正文为空；请把推文正文粘贴进来', title, text: '', link, nickname, biz};
  }
  return {ok: true, title: title || text.split('\n').map(s => s.trim()).find(Boolean) || '公众号文章', text, publishedAt, link, nickname, biz};
}

export {normalizeUrl};
