// 文章归属：优先 biz，其次昵称，再退到正文里出现的账号名/学校名；不确定就返回 null，不硬猜。
import {accountNameKey, bizOf, canonicalArticleUrl, normalizeAccountName, parseWechatMeta} from './identity.mjs';

export function accountNames(account) {
  const names = [account?.name, ...(account?.aliasNames || account?.aliases?.names || [])];
  return [...new Set(names.map(normalizeAccountName).filter(Boolean))];
}

export function accountBizList(account) {
  const list = [account?.biz, ...(account?.aliasBiz || account?.aliases?.biz || [])];
  return [...new Set(list.filter(Boolean))];
}

function nameHit(haystack, name) {
  const key = accountNameKey(name);
  if (key.length < 3) return false;
  return accountNameKey(haystack).includes(key);
}

// 返回 {account, reason, score}；没有可信匹配时返回 null。
// strict=true 时不使用“正文提到账号名”这种弱证据，只认 biz/昵称。
export function matchAccount(accounts, {accountId = '', biz = '', nickname = '', title = '', text = '', strict = false} = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (accountId) {
    const hit = list.find(a => a.id === accountId);
    if (hit) return {account: hit, reason: 'explicit', score: 1};
  }
  const cleanBiz = String(biz || '').trim();
  if (cleanBiz) {
    const hit = list.find(a => accountBizList(a).includes(cleanBiz));
    if (hit) return {account: hit, reason: 'biz', score: 0.98};
  }
  const cleanNick = normalizeAccountName(nickname);
  if (cleanNick) {
    const key = accountNameKey(cleanNick);
    const exact = list.find(a => key && accountNames(a).some(name => accountNameKey(name) === key));
    if (exact) return {account: exact, reason: 'nickname', score: 0.95};
    const loose = list.find(a => key && accountNames(a).some(name => {
      const other = accountNameKey(name);
      return other.length >= 4 && (other.includes(key) || key.includes(other));
    }));
    if (loose) return {account: loose, reason: 'nickname', score: 0.85};
  }
  if (strict) return null;

  const haystack = [title, text].filter(Boolean).join('\n');
  if (!haystack) return null;
  let best = null;
  for (const account of list) {
    for (const name of accountNames(account)) {
      if (name.length < 3) continue;
      if (!nameHit(haystack, name)) continue;
      const score = 0.7 + Math.min(0.15, name.length / 200);
      if (!best || score > best.score || (score === best.score && name.length > (best.name || '').length)) {
        best = {account, reason: 'content', score, name};
      }
    }
  }
  if (best) return best;

  // 部分推文只在正文里写“中山大学就业”，没有昵称；学校全名 + 就业/校招也作为弱证据。
  for (const account of list) {
    const school = String(account.school || '').trim();
    if (!school) continue;
    if (haystack.includes(school) && /就业|校招|招聘/.test(haystack)) {
      const score = 0.55;
      if (!best || score > best.score) best = {account, reason: 'school', score, name: school};
    }
  }
  return best;
}

// 从任意来源页/HTML/文本里发现公众号：文章链接按 __biz 分组，锚文本或“名称 | 链接”行提供昵称。
export function discoverAccounts(text, {school = ''} = {}) {
  const body = String(text || '').replace(/&amp;/g, '&');
  const byBiz = new Map();
  const isArticleLink = value => {
    try { return new URL(value).pathname.startsWith('/s'); } catch { return false; }
  };
  const add = (biz, name, link) => {
    const key = biz || '';
    if (!byBiz.has(key)) byBiz.set(key, {biz: key, name: normalizeAccountName(name), school, articleUrls: []});
    const item = byBiz.get(key);
    if (!item.name && name) item.name = normalizeAccountName(name);
    if (link && !item.articleUrls.includes(link)) item.articleUrls.push(link);
  };

  // 1) 文章链接 + 锚文本：“<a href="...__biz=...">中山大学就业</a>”
  for (const m of body.matchAll(/<a\b[^>]*href=["']([^"']*mp\.weixin\.qq\.com[^"']*)["'][^>]*>([\s\S]{1,120}?)<\/a>/gi)) {
    const link = canonicalArticleUrl(m[1]);
    if (!link) continue;
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const profile = /\/mp\/(profile_ext|appmsgalbum)/.test(m[1]);
    const name = profile && /^[\u4e00-\u9fa5A-Za-z0-9·（）()_-]{2,40}$/.test(label) ? label : '';
    add(bizOf(link), name, isArticleLink(link) ? link : '');
  }
  // 2) 纯文本里的文章链接（可能没有昵称）
  for (const m of body.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>\\)]+/g)) {
    const link = canonicalArticleUrl(m[0]);
    if (link && isArticleLink(link)) add(bizOf(link), '', link);
  }
  // 3) “公众号名 | 文章链接”这种一行一条的清单
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*([^|｜:：\t]{2,40}?)\s*[|｜:：\t]+\s*(https?:\/\/mp\.weixin\.qq\.com\/[^\s]+)\s*$/);
    if (!m) continue;
    const link = canonicalArticleUrl(m[2]);
    if (!link) continue;
    add(bizOf(link), m[1], link);
  }
  return [...byBiz.values()].filter(item => item.biz || item.name || item.articleUrls.length);
}

export function metaForArticle({html = '', url = '', text = ''} = {}) {
  const meta = parseWechatMeta(html, url);
  if (!meta.biz) meta.biz = bizOf(url);
  if (!meta.nickname && text) {
    // 浏览器渲染后的正文第一屏通常第一行是公众号名；只在短行时采用。
    const first = String(text).split('\n').map(s => s.trim()).find(Boolean) || '';
    if (first.length >= 3 && first.length <= 40 && /[\u4e00-\u9fa5A-Za-z]/.test(first)) meta.nickname = first;
  }
  return meta;
}
