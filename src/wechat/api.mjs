// 公众号文章库：粘贴文章链接 → 抓取并记录标题/时间/摘要 → 产出活动草稿，人工确认后入库。
import {join} from 'node:path';
import {WeChatStore} from './store.mjs';
import {fetchText} from '../recruit/fetch.mjs';
import {analyzeArticle} from './analyze.mjs';
import {fetchWechatArticle} from './fetch-article.mjs';
import {harvestWechat} from './harvest.mjs';

export function bizOf(url) {
  try { return new URL(url).searchParams.get('__biz') || ''; } catch { return ''; }
}

export async function handleWechat({method, pathname, url, body, dir}) {
  const store = WeChatStore.open(join(dir, 'wechat.db'));
  try {
    if (method === 'GET') {
      if (pathname === 'accounts') return {json: {accounts: store.listAccounts(), stats: store.stats(), articles: store.listArticles({limit: 30})}};
      if (pathname === 'articles') return {json: {articles: store.listArticles({accountId: url?.searchParams.get('account') || ''})}};
      return null;
    }
    if (method === 'POST') {
      if (pathname === 'accounts') {
        try { return {json: {account: store.addAccount(body || {})}}; }
        catch (e) { return {status: 400, json: {error: e.message}}; }
      }
      if (pathname === 'articles/import') {
        const link = String(body?.url || '').trim();
        if (!/^https?:\/\//.test(link)) return {status: 400, json: {error: '请填写公众号文章链接'}};
        const pasted = String(body?.text || '').trim();
        const got = await fetchWechatArticle(link);
        let text = got.ok ? got.text : '';
        let title = got.ok ? got.title : '';
        let publishedAt = got.ok ? got.publishedAt || '' : '';
        if (text.trim().length < 120) {
          if (pasted.length < 10) {
            return {status: 400, json: {error: got.message || '微信文章需要验证，链接抓不到正文。请把推文正文粘贴到下方再导入。', needPaste: true}};
          }
          text = pasted;
          title = String(body?.title || '').trim() || pasted.split('\n').map(s => s.trim()).find(Boolean) || '公众号文章';
        }
        text = text.slice(0, 20000);
        title = title.slice(0, 200);
        let account = body?.accountId ? store.getAccount(body.accountId) : null;
        if (!account && body?.accountName) account = store.addAccount({name: body.accountName, school: body.school || ''});
        if (!account) account = store.accountByBiz(bizOf(got.link || link));
        if (!account) account = store.addAccount({name: '未归类公众号', note: '从文章链接自动创建；请在左侧补名称'});
        const article = store.saveArticle({
          accountId: account.id, title, url: got.link || link, publishedAt,
          summary: text.slice(0, 300), content: text
        });
        const analysis = analyzeArticle({title, text, url: got.link || link});
        const saved = store.saveAnalysis(article.id, analysis);
        return {json: {article: saved, analysis, draft: analysis.draft, account}};
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
      if (pathname.startsWith('articles/') && pathname.endsWith('/analyze')) {
        const id = pathname.split('/')[1];
        const article = store.getArticle(id);
        if (!article) return {status: 404, json: {error: '文章不存在'}};
        const analysis = analyzeArticle({title: article.title, text: article.content || article.summary || '', url: article.url});
        return {json: {article: store.saveAnalysis(id, analysis), analysis}};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/link')) {
        const id = pathname.split('/')[1];
        const article = store.getArticle(id);
        if (!article) return {status: 404, json: {error: '文章不存在'}};
        store.saveArticle({...article, eventId: String(body?.eventId || '')});
        return {json: {ok: true, article: store.getArticle(id)}};
      }
      if (pathname.startsWith('articles/') && pathname.endsWith('/delete')) {
        store.deleteArticle(pathname.split('/')[1]);
        return {json: {ok: true}};
      }
      return null;
    }
    return null;
  } finally { store.close(); }
}
