import {publicUrl} from './util.mjs';

export async function publicSearch(args, ctx) {
  const searchUrl = ctx.config?.searchUrl;
  if (!searchUrl) return {status: 'unavailable', message: '当前接口未配置通用搜索服务。可使用已连接的平台工具，不能声称已联网搜索。', sources: []};
  const u = new URL(searchUrl);
  u.searchParams.set('q', args.query);
  u.searchParams.set('format', 'json');
  const r = await ctx.fetchImpl(u, {signal: ctx.signal, redirect: 'error'});
  if (!r.ok) throw new Error('搜索服务响应 HTTP ' + r.status);
  const d = await r.json();
  return {
    status: 'readable',
    notice: '以下为搜索引擎返回的摘要，不代表已读取网页正文。',
    sources: (d.results || []).filter(x => publicUrl(x.url)).slice(0, 8).map(x => ({title: String(x.title || ''), url: x.url, snippet: String(x.content || '').slice(0, 2000)}))
  };
}

export async function companyResearch(args, ctx) {
  const searchUrl = ctx.config?.searchUrl;
  if (!searchUrl) return {status: 'unavailable', message: '当前接口未配置通用搜索服务，无法做公司调研。可在“模型与接口 → 高级选项”里填写 SearXNG 地址，或改为读取已连接平台的公开页面。', sources: []};
  const company = String(args.company || '').trim();
  const city = String(args.city || '').trim().slice(0, 20);
  const queries = [company + ' 公司 介绍 行业', company + (city ? ' ' + city : '') + ' 校园招聘 待遇 口碑'];
  const sources = [];
  for (const query of queries) {
    const u = new URL(searchUrl);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    const r = await ctx.fetchImpl(u, {signal: ctx.signal, redirect: 'error'});
    if (!r.ok) throw new Error('搜索服务响应 HTTP ' + r.status);
    const d = await r.json();
    for (const x of (d.results || []).filter(x => publicUrl(x.url)).slice(0, 5)) {
      if (sources.some(s => s.url === x.url)) continue;
      sources.push({title: String(x.title || ''), url: x.url, snippet: String(x.content || '').slice(0, 1200), query});
    }
  }
  return {
    status: sources.length ? 'readable' : 'empty',
    company,
    notice: '以下是公开搜索摘要，不等于公司官方口径；待遇与评价请以来源原文为准，不要据此推断录用概率。',
    sources: sources.slice(0, 8)
  };
}
