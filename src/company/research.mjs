// 公司调研数据源：从招聘活动/项目单位名批量生成有来源的公司档案。
// 只把搜索服务实际返回的摘要落库，逐条带来源 URL，不归纳、不编造；
// 未配置通用搜索服务时明确返回不可用，绝不假装成功。
import {join} from 'node:path';
import {RecruitStore} from '../recruit/store.mjs';
import {CompanyStore} from './store.mjs';
import {publicUrl} from '../tools/handlers/util.mjs';

const MAX_PER_QUERY = 5;
const MAX_TOTAL = 8;
const MAX_SOURCES = 20;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function companyQueries(company, city = '') {
  const name = String(company || '').trim();
  const c = String(city || '').trim().slice(0, 20);
  return [
    name + ' 公司 介绍 行业',
    name + (c ? ' ' + c : '') + ' 校园招聘 待遇 口碑'
  ];
}

// 调一次通用搜索服务（SearXNG format=json），返回去重后的来源摘要。
// 只保留 http/https 且无用户名密码的公开链接；搜索失败由调用方决定跳过还是报错。
export async function searchCompanySources({
  company, city = '', searchUrl, fetchImpl = fetch, signal = null,
  maxPerQuery = MAX_PER_QUERY, maxTotal = MAX_TOTAL
} = {}) {
  const sources = [];
  for (const query of companyQueries(company, city)) {
    const u = new URL(searchUrl);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    const r = await fetchImpl(u, {signal, redirect: 'error'});
    if (!r.ok) throw new Error('搜索服务响应 HTTP ' + r.status);
    const d = await r.json();
    for (const x of (d.results || []).filter(x => publicUrl(x.url)).slice(0, maxPerQuery)) {
      if (sources.some(s => s.url === x.url)) continue;
      sources.push({title: String(x.title || ''), url: x.url, snippet: String(x.content || '').slice(0, 1200), query});
    }
    if (sources.length >= maxTotal) break;
  }
  return sources.slice(0, maxTotal);
}

// 由单位名 + 来源摘要拼出一份公司档案：正文逐条带来源 URL，其余字段留空（不编造）。
export function buildCompanyProfile(name, sources) {
  const list = (sources || []).filter(s => s && publicUrl(s.url)).slice(0, MAX_SOURCES);
  const summary = list.map((s, i) => (i + 1) + '. ' + (s.title || s.url) + '（' + s.url + '）：' + (s.snippet || '')).join('\n');
  return {
    name: String(name || '').trim(),
    summary,
    sources: list.map(s => ({title: String(s.title || '').slice(0, 120), url: s.url})),
    notes: '批量生成自招聘活动/项目单位名；正文为搜索摘要原文，未做归纳推断。'
  };
}

// 批量生成：取招聘库高频单位名 → 逐个搜索 → 落库为带来源的公司档案。
// 已有档案的单位跳过（幂等，不覆盖用户编辑）；单家失败不中断整批。
export async function generateCompanyProfiles({
  dataDir, searchUrl = '', fetchImpl = fetch, signal = null, limit = DEFAULT_LIMIT
} = {}) {
  const cap = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  if (!searchUrl) {
    return {
      status: 'unavailable',
      message: '未配置通用搜索服务，无法生成公司档案。请在“模型与接口 → 通用联网搜索”里填写 SearXNG 地址后再运行；未配置时不会伪造任何公司信息。',
      generated: 0, skipped: 0, total: 0, companies: []
    };
  }
  const recruit = RecruitStore.open(join(dataDir, 'recruit.db'));
  let names;
  try { names = recruit.unitNameCounts({limit: cap}); } finally { recruit.close(); }
  if (!names.length) {
    return {
      status: 'empty',
      message: '招聘库里还没有单位名，无法生成公司档案。请先采集招聘活动或项目。',
      generated: 0, skipped: 0, total: 0, companies: []
    };
  }
  const store = CompanyStore.open(join(dataDir, 'company.db'));
  const companies = [];
  let generated = 0, skipped = 0;
  try {
    for (const item of names) {
      if (signal?.aborted) break;
      if (store.byName(item.name)) { skipped++; continue; }
      let sources = [];
      try {
        sources = await searchCompanySources({company: item.name, searchUrl, fetchImpl, signal});
      } catch { skipped++; continue; }
      if (!sources.length) { skipped++; continue; }
      companies.push(store.save(buildCompanyProfile(item.name, sources)));
      generated++;
    }
  } finally { store.close(); }
  return {
    status: 'readable',
    generated, skipped, total: names.length, companies,
    message: generated
      ? `已为 ${generated} 家单位生成带来源的公司档案，跳过 ${skipped} 家。`
      : `本次没有新生成公司档案，跳过 ${skipped} 家（可能已覆盖或未搜到公开信息）。`
  };
}
