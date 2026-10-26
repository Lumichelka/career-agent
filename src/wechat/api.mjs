// 公众号文章库：链接/正文导入 → 自动归属 → 分析 → 可选写入招聘库；也负责账号订阅同步。
import {join} from 'node:path';
import {WeChatStore} from './store.mjs';
import {fetchText} from '../recruit/fetch.mjs';
import {analyzeArticle} from './analyze.mjs';
import {fetchWechatArticle} from './fetch-article.mjs';
import {harvestWechat} from './harvest.mjs';
import {publishArticle} from './publish.mjs';
import {syncAccount, syncSubscriptions, discoverAndSubscribe} from './subscribe.mjs';
import {discoverAccounts} from './attribute.mjs';
import {bizOf, canonicalArticleUrl, isDemoUrl} from './identity.mjs';
import {purgeDemoRecruitEvents} from '../recruit/demo-purge.mjs';

export {bizOf};

function firstLine(text) {
  return String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '公众号文章';
}

export async function handleWechat({method, pathname, url, body, dir, userId = '', actorType = 'model', actorRef = '', deps = {}} = {}) {
  const store = WeChatStore.open(join(dir, 'wechat.db'));
  const fetchArticle = deps.fetchArticle || fetchWechatArticle;
  const analyze = deps.analyze || analyzeArticle;
  const autoPublish = deps.autoPublish !== false;
  // 公众号自动发布是自动写入：有登录身份时经写网关写业务行 + write_audit；CLI 用 cli 身份同样留痕。
  const audit = userId ? {userId, actorType: actorType || 'model', actorRef: actorRef || ''} : null;
  try {
    if (method === 'GET') {
      if (pathname === 'accounts') {
        const accounts = store.listAccounts();
        const byId = Object.fromEntries(accounts.map(a => [a.id, a.name]));
        return {json: {
          accounts,
          stats: store.stats(),
          articles: store.listArticles({limit: 50}).map(a => ({...a, accountName: byId[a.accountId] || '未归属'}))
        }};
      }
      if (pathname === 'articles') {
        const accounts = Object.fromEntries(store.listAccounts().map(a => [a.id, a.name]));
        return {json: {articles: store.listArticles({accountId: url?.searchParams.get('account') || '', limit: 200}).map(a => ({...a, accountName: accounts[a.accountId] || '未归属'}))}};
      }
      return null;
    }
    if (method === 'POST') {
      if (pathname === 'accounts') {
        try { return {json: {account: store.addAccount(body || {})}}; }
        catch (e) { return {status: 400, json: {error: e.message}}; }
      }
      if (pathname === 'discover') {
        let sourceText = String(body?.text || '');
        if (!sourceText && body?.url) {
          const link = String(body.url);
          if (!/^https?:\/\//.test(link)) return {status: 400, json: {error: '来源页链接需以 http:// 或 https:// 开头'}};
          const feed = deps.fetchFeed ? await deps.fetchFeed(link) : await fetchText(link, {timeout: 20000, retries: 0, minInterval: 0});
          if (!feed?.ok) return {status: 400, json: {error: '来源页打不开：' + (feed?.message || '未知原因')}};
          sourceText = feed.text || '';
        }
        if (!sourceText) return {status: 400, json: {error: '请粘贴来源页 HTML/正文，或提供来源页链接'}};
        const candidates = discoverAndSubscribe(store, {text: sourceText, school: String(body?.school || ''), feedUrl: String(body?.url || '').trim()});
        return {json: {candidates: candidates.length ? candidates : discoverAccounts(sourceText, {school: String(body?.school || '')})}};
      }
      if (pathname === 'sync') {
        const id = String(body?.accountId || '');
        const accounts = id ? [store.getAccount(id)].filter(Boolean) : undefined;
        if (id && !accounts?.length) return {status: 404, json: {error: '账号不存在'}};
        const out = await syncSubscriptions({
          store, accounts, dir,
          fetchFeed: deps.fetchFeed, fetchArticle, analyze, audit,
          publish: deps.syncPublish === true, limit: Number(body?.limit) || 5,
          onLog: deps.onLog
        });
        return {json: out};
      }
      if (pathname === 'purge-demo') {
        const removedArticles = store.purgeDemoData();
        let removedEvents = 0, auditBatchId = '';
        try {
          const out = purgeDemoRecruitEvents({dir, userId: userId || 'cli', actorType: actorType || (userId ? 'model' : 'cli'), actorRef});
          removedEvents = out.removed;
          auditBatchId = out.batchId;
        } catch { /* 招聘库尚未建立 */ }
        return {json: {removedArticles, removedEvents, auditBatchId, stats: store.stats()}};
      }
      if (pathname.startsWith('accounts/') && pathname.endsWith('/subscribe')) {
        const id = pathname.split('/')[1];
        if (!store.getAccount(id)) return {status: 404, json: {error: '账号不存在'}};
        try {
          const account = store.setSubscription(id, body?.feedUrl || '');
          const synced = body?.sync ? await syncAccount(store, store.getAccount(id), {
            dir, fetchFeed: deps.fetchFeed, fetchArticle, analyze, audit,
            publish: deps.syncPublish === true, limit: Number(body?.limit) || 5, onLog: deps.onLog
          }) : null;
          return {json: {account: store.getAccount(id), sync: synced}};
        } catch (e) { return {status: 400, json: {error: e.message}}; }
      }
      if (pathname.startsWith('accounts/') && pathname.endsWith('/sync')) {
        const id = pathname.split('/')[1];
        const account = store.getAccount(id);
        if (!account) return {status: 404, json: {error: '账号不存在'}};
        const out = await syncAccount(store, account, {
          dir, fetchFeed: deps.fetchFeed, fetchArticle, analyze, audit,
          publish: deps.syncPublish === true, limit: Number(body?.limit) || 5, onLog: deps.onLog
        });
        return {json: out};
      }
      if (pathname === 'articles/import') {
        const rawLink = String(body?.url || '').trim();
        const link = canonicalArticleUrl(rawLink);
        if (!link || !/^https?:\/\//.test(rawLink)) return {status: 400, json: {error: '请填写公众号文章链接'}};
        if (isDemoUrl(link)) return {status: 400, json: {error: 'example.com 等示例域名不能作为公众号文章链接'}};
        const pasted = String(body?.text || '').trim();
        let got = null;
        try { got = await fetchArticle(link); }
        catch (e) { got = {ok: false, message: e.message}; }
        let text = got?.ok ? String(got.text || '') : '';
        let title = String(got?.title || body?.title || '').trim();
        let publishedAt = String(got?.publishedAt || body?.publishedAt || '');
        const nickname = String(got?.nickname || body?.nickname || '').trim().slice(0, 80);
        const biz = String(got?.biz || bizOf(link) || '').slice(0, 200);
        if (text.trim().length < 120) {
          if (pasted.length < 10) {
            return {status: 400, json: {error: got?.message || '微信文章需要验证，链接抓不到正文。请把推文正文粘贴到下方再导入。', needPaste: true}};
          }
          text = pasted;
          title = title || firstLine(pasted);
        }
        text = text.slice(0, 20000);
        title = (title || firstLine(text)).slice(0, 200);
        let account = body?.accountId ? store.getAccount(String(body.accountId)) : null;
        if (!account && body?.accountName) account = store.addAccount({name: body.accountName, school: body.school || '', biz, nickname});
        if (!account) account = store.resolveAccount({biz, nickname, title, text, school: String(body?.school || '')});
        if (!account && nickname) account = store.addAccount({name: nickname, school: String(body?.school || ''), biz, note: '从文章昵称自动创建'});
        if (!account) account = store.accountByBiz(biz);
        if (!account) account = store.addAccount({name: '未归类公众号', note: '从文章链接自动创建；请补名称或订阅来源'});
        const article = store.saveArticle({
          accountId: account.id, title, url: got?.link || link, publishedAt,
          summary: text.slice(0, 300), content: text, nickname, biz
        });
        const analysis = analyze({title: article.title, text, url: article.url});
        const saved = store.saveAnalysis(article.id, analysis);
        let published = null;
        if (autoPublish && (analysis.projects || []).length && analysis.draft?.startAt) {
          published = await publishArticle({dir, articleId: saved.id, store, recruitStore: deps.recruitStore, audit});
        }
        return {json: {
          article: published?.ok ? store.getArticle(saved.id) : saved,
          analysis, draft: analysis.draft,
          account: store.getAccount(account.id),
          publish: published,
          event: published?.event || null,
          projects: published?.projects || []
        }};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/analyze')) {
        const id = pathname.split('/')[1];
        const article = store.getArticle(id);
        if (!article) return {status: 404, json: {error: '文章不存在'}};
        const analysis = analyze({title: article.title, text: article.content || article.summary || '', url: article.url});
        return {json: {article: store.saveAnalysis(id, analysis), analysis}};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/publish')) {
        const id = pathname.split('/')[1];
        const out = await publishArticle({dir, articleId: id, store, recruitStore: deps.recruitStore, audit});
        return out.ok ? {json: out} : {status: out.reason === 'not_found' ? 404 : 422, json: out};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/link')) {
        const id = pathname.split('/')[1];
        const article = store.getArticle(id);
        if (!article) return {status: 404, json: {error: '文章不存在'}};
        store.linkEvent(id, String(body?.eventId || ''));
        return {json: {ok: true, article: store.getArticle(id)}};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/delete')) {
        store.deleteArticle(pathname.split('/')[1]);
        return {json: {ok: true}};
      }
      if (pathname === 'harvest') {
        const link = String(body?.url || '').trim();
        const pasted = String(body?.text || '').trim();
        let sourceText = pasted;
        if (link) {
          const res = await fetchText(link, {timeout: 20000, retries: 0, minInterval: 0});
          if (!res.ok) return {status: 400, json: {error: '来源页打不开：' + res.message}};
          sourceText = res.text;
        }
        if (!sourceText) return {status: 400, json: {error: '请提供来源页链接或 HTML/正文'}};
        const out = await harvestWechat({text: sourceText, dir, school: String(body?.school || ''), limit: Number(body?.limit) || 3});
        return {json: out};
      }
      return null;
    }
    return null;
  } finally { store.close(); }
}
