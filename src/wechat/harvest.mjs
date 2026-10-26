// 从高校来源页/正文里发现公众号文章链接，抓取并分析；不批量爬公众号主页。
import {join} from 'node:path';
import {WeChatStore} from './store.mjs';
import {fetchWechatArticle} from './fetch-article.mjs';
import {analyzeArticle} from './analyze.mjs';
import {bizOf, canonicalArticleUrl} from './identity.mjs';

export function findWechatLinks(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>\\)]+/g)) {
    const link = canonicalArticleUrl(m[0]);
    if (link) out.add(link);
  }
  return [...out];
}

export async function harvestWechat({text, dir, school = '', limit = 3, onLog = () => {}} = {}) {
  const links = findWechatLinks(text).slice(0, Math.max(1, Math.min(8, limit)));
  const result = {links: links.length, imported: 0, skipped: 0, articles: []};
  if (!links.length) return result;
  const store = WeChatStore.open(join(dir, 'wechat.db'));
  try {
    for (const link of links) {
      if (store.hasArticle(link)) { result.skipped++; continue; }
      const got = await fetchWechatArticle(link);
      if (!got.ok) { result.skipped++; onLog?.({text: '公众号跳过：' + got.message}); continue; }
      const biz = got.biz || bizOf(link);
      const owner = store.resolveAccount({biz, nickname: got.nickname, title: got.title, text: got.text, school});
      const account = owner || store.addAccount({name: got.nickname || '未归类公众号', school, biz, note: '从来源页发现的文章链接'});
      const analysis = analyzeArticle({title: got.title, text: got.text, url: link});
      const article = store.saveArticle({
        accountId: account.id, title: got.title, url: got.link || link, publishedAt: got.publishedAt,
        summary: got.text.slice(0, 300), content: got.text, nickname: got.nickname || '', biz
      });
      const saved = store.saveAnalysis(article.id, analysis);
      result.imported++;
      result.articles.push({id: saved.id, title: saved.title, account: account.name, hasRecruitment: saved.hasRecruitment, projects: analysis.projects.length});
      onLog?.({text: '公众号入库：' + got.title.slice(0, 30) + '（' + saved.hasRecruitment + '，' + analysis.projects.length + ' 项目草稿）'});
    }
    return result;
  } finally { store.close(); }
}
