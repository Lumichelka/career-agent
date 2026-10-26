// 账号发现/订阅：把账号的公开来源页（学校就业网、公众号矩阵页等）当作订阅源，
// 发现文章链接 → 抓取正文 → 自动归属到账号 → 分析 → 可选写入招聘库。
// 不抓微信登录态，也不绕过验证；抓不到就记录原因并保留粘贴正文的入口。
import {fetchText} from '../recruit/fetch.mjs';
import {fetchWechatArticle} from './fetch-article.mjs';
import {analyzeArticle} from './analyze.mjs';
import {publishArticle} from './publish.mjs';
import {discoverAccounts} from './attribute.mjs';
import {canonicalArticleUrl, isDemoUrl} from './identity.mjs';

export function findArticleLinks(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>\)]+/g)) {
    const link = canonicalArticleUrl(m[0]);
    if (link) out.add(link);
  }
  for (const candidate of discoverAccounts(text)) {
    for (const link of candidate.articleUrls) if (link) out.add(link);
  }
  return [...out];
}

async function defaultFetchFeed(url) {
  const res = await fetchText(url, {timeout: 20000, retries: 0, minInterval: 0});
  return res.ok ? {ok: true, text: res.text, url: res.url || url, message: ''} : {ok: false, message: res.message || res.reason || '来源页打不开'};
}

async function ingestArticle({store, account, link, fetchArticle, analyze, dir, publish = false, recruitStore, audit = null, onLog}) {
  const canonical = canonicalArticleUrl(link);
  if (!canonical) return {ok: false, reason: 'invalid_link'};
  if (isDemoUrl(canonical)) return {ok: false, reason: 'demo_link', message: '示例域名链接不导入'};
  if (store.hasArticle(canonical)) return {ok: false, reason: 'duplicate'};
  let got;
  try { got = await fetchArticle(canonical); }
  catch (e) { return {ok: false, reason: 'fetch_error', message: e.message}; }
  if (!got?.ok) return {ok: false, reason: 'fetch_failed', message: got?.message || '抓取失败'};
  const body = String(got.text || '');
  if (body.trim().length < 120) return {ok: false, reason: 'too_short', message: '正文过短，可能需要粘贴正文'};
  const nickname = String(got.nickname || account.name || '').slice(0, 80);
  const biz = String(got.biz || '').slice(0, 200);
  const owner = store.resolveAccount({
    accountId: account.id, biz, nickname,
    title: got.title || '', text: body, school: account.school
  }) || account;
  const article = store.saveArticle({
    accountId: owner.id,
    title: got.title || body.split('\n').map(s => s.trim()).find(Boolean) || '公众号文章',
    url: got.link || canonical,
    publishedAt: got.publishedAt || '',
    summary: body.slice(0, 300),
    content: body,
    nickname, biz
  });
  const analysis = (analyze || analyzeArticle)({title: article.title, text: body, url: article.url});
  const saved = store.saveAnalysis(article.id, analysis);
  let published = null;
  if (publish && dir) {
    try { published = await publishArticle({dir, articleId: saved.id, store, recruitStore, audit}); }
    catch (e) { published = {ok: false, reason: 'publish_error', message: e.message}; }
  }
  onLog?.({text: '公众号入库：' + saved.title.slice(0, 30) + '（' + saved.hasRecruitment + '，' + (analysis.projects || []).length + ' 项目草稿）'});
  return {ok: true, article: saved, analysis, published};
}

/**
 * 同步一个订阅账号：抓取订阅页 → 发现文章 → 逐篇入库。
 * 所有网络/分析函数都可注入，测试不访问外网。
 */
export async function syncAccount(store, account, {
  fetchFeed = defaultFetchFeed,
  fetchArticle = fetchWechatArticle,
  analyze = analyzeArticle,
  limit = 5,
  dir = '',
  publish = false,
  recruitStore,
  audit = null,
  onLog
} = {}) {
  const feedUrl = account?.feedUrl || '';
  if (!feedUrl) {
    store.markSync(account.id, {status: 'disabled', error: '未配置订阅地址'});
    return {accountId: account.id, name: account.name, status: 'disabled', links: 0, imported: 0, skipped: 0, failed: 0, message: '未配置订阅地址'};
  }
  const result = {accountId: account.id, name: account.name, status: 'ok', links: 0, imported: 0, skipped: 0, failed: 0, articles: [], message: ''};
  try {
    const feed = await fetchFeed(feedUrl);
    if (!feed?.ok) {
      result.status = 'error';
      result.message = feed?.message || '订阅页打不开';
      store.markSync(account.id, {status: 'error', error: result.message});
      return result;
    }
    const links = findArticleLinks(feed.text || '').slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
    result.links = links.length;
    if (!links.length) {
      result.status = 'empty';
      result.message = '订阅页可访问，但没有发现公众号文章链接';
      store.markSync(account.id, {status: 'empty', error: result.message, count: 0});
      return result;
    }
    const current = store.getAccount(account.id) || account;
    for (const link of links) {
      if (store.hasArticle(link)) { result.skipped++; continue; }
      const got = await ingestArticle({store, account: current, link, fetchArticle, analyze, dir, publish, recruitStore, audit, onLog});
      if (got.ok) {
        result.imported++;
        result.articles.push({id: got.article.id, title: got.article.title, hasRecruitment: got.article.hasRecruitment, projects: (got.analysis.projects || []).length});
      } else if (got.reason === 'duplicate') {
        result.skipped++;
      } else {
        result.failed++;
        onLog?.({text: '公众号跳过：' + (got.message || got.reason)});
      }
    }
    result.status = result.failed && !result.imported ? 'error' : 'ok';
    result.message = '发现 ' + links.length + ' 篇，新增 ' + result.imported + ' 篇' + (result.failed ? '，失败 ' + result.failed + ' 篇' : '');
    store.markSync(account.id, {status: result.status, error: result.status === 'error' ? result.message : '', count: result.imported});
    return result;
  } catch (e) {
    result.status = 'error';
    result.message = e.message;
    store.markSync(account.id, {status: 'error', error: e.message});
    return result;
  }
}

export async function syncSubscriptions({store, accounts, ...options} = {}) {
  const list = (accounts || store.listSubscribed()).filter(a => a?.feedUrl);
  const results = [];
  for (const account of list) results.push(await syncAccount(store, account, options));
  return {
    accounts: results.length,
    imported: results.reduce((sum, r) => sum + (r.imported || 0), 0),
    skipped: results.reduce((sum, r) => sum + (r.skipped || 0), 0),
    failed: results.reduce((sum, r) => sum + (r.failed || 0), 0),
    results
  };
}

// 给 API/CLI 用：从一个来源页发现账号，已有账号直接返回，新账号按昵称创建（没有昵称的不创建）。
// feedUrl 是发现账号的来源页；发现成功后顺手订阅，后续可以直接 sync。
export function discoverAndSubscribe(store, {text = '', school = '', feedUrl = ''} = {}) {
  const candidates = discoverAccounts(text, {school});
  return candidates.map(candidate => {
    let account = candidate.biz ? store.accountByBiz(candidate.biz) : null;
    if (!account && candidate.name) account = store.addAccount({name: candidate.name, school, biz: candidate.biz, note: '从来源页发现'});
    if (account && feedUrl && !account.feedUrl) account = store.setSubscription(account.id, feedUrl);
    return {...candidate, accountId: account?.id || '', accountName: account?.name || candidate.name || '', feedUrl: account?.feedUrl || ''};
  });
}
