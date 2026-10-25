// 从高校来源页/正文里发现公众号文章链接，抓取并分析；不批量爬公众号主页。
import {join} from 'node:path';
import {WeChatStore} from './store.mjs';
import {fetchWechatArticle, normalizeUrl} from './fetch-article.mjs';
import {analyzeArticle} from './analyze.mjs';

function bizOf(url) {
  try { return new URL(url).searchParams.get('__biz') || ''; } catch { return ''; }
}

export function findWechatLinks(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>\\]+/g)) {
    const link = normalizeUrl(m[0].replace(/&amp;/g, '&'));
    if (link) out.add(link);
  }
  return [...out];
}

export async function harvestWechat({text, dir, school = '', limit = 3, onLog = () => {}}) {
  const links = findWechatLinks(text).slice(0, Math.max(1, Math.min(8, limit)));
  const result = {links: links.length, imported: 0, skipped: 0, articles: []};
  if (!links.length) return result;
  const store = WeChatStore.open(join(dir, 'wechat.db'));
  try {
    for (const link of links) {
      const got = await fetchWechatArticle(link);
      if (!got.ok) { result.skipped++; onLog?.({text: `公众号跳过：${got.message}`}); continue; }
      const biz = bizOf(link);
      let account = biz ? store.accountByBiz(biz) : null;
      if (!account) account = store.addAccount({name: '未归类公众号', school, note: '从来源页发现的文章链接'});
      const analysis = analyzeArticle({title: got.title, text: got.text, url: link});
      const article = store.saveArticle({
        accountId: account.id, title: got.title, url: link, publishedAt: got.publishedAt,
        summary: got.text.slice(0, 300), content: got.text
      });
      const saved = store.saveAnalysis(article.id, analysis);
      result.imported++;
      result.articles.push({id: saved.id, title: saved.title, account: account.name, hasRecruitment: saved.hasRecruitment, projects: analysis.projects.length});
      onLog?.({text: `公众号入库：${got.title.slice(0, 30)}（${saved.hasRecruitment}，${analysis.projects.length} 项目草稿）`});
    }
    return result;
  } finally { store.close(); }
}
