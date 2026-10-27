// 西南石油大学双选会：列表接口 + 参会单位接口（云研系统，均无需登录）。
import {fetchText} from '../fetch.mjs';
import {SourceError} from './error.mjs';

const BASE = 'https://jyzx.swpu.edu.cn';

function secondsIso(seconds) {
  const n = Number(seconds);
  if (!n) return '';
  return new Date(n * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

// list_jobfair_company 按「岗位」返回记录：一个单位多个岗位会拆成多行。
// 岗位/要求/投递方式优先取真实字段；读不到就留空并在 notes 标「未公布」，不编造。
export function parseCompanies(json) {
  return (json?.data || []).map(r => {
    const company = String(r.company_name || '').trim();
    if (!company) return null;
    const jobName = String(r.job_name || r.job_recruitment || '').trim();
    const degree = String(r.degree_require || '').trim();
    const major = String(r.about_major || r.professionals || '').trim();
    const salary = String(r.salary || '').trim();
    const jobNumber = String(r.job_number || '').trim();
    const publishType = String(r.publish_type || '').trim();
    // 岗位：岗位名称 + 招聘人数 + 薪资（可筛岗、可搜索）
    const positions = [jobName, salary ? '薪资 ' + salary : '', jobNumber ? '招聘 ' + jobNumber + ' 人' : ''].filter(Boolean).join('；');
    // 要求：学历 + 专业
    const requirements = [degree ? '学历 ' + degree : '', major ? '专业 ' + major : ''].filter(Boolean).join('；');
    // 投递方式：双选会默认为现场；publish_type 标注网络招聘时改为网申。
    const applyMode = /网络/.test(publishType) ? '网申' : '现场';
    const notes = [
      r.industry_category ? '行业：' + r.industry_category : '',
      r.scale ? '规模：' + r.scale : '',
      r.city_name ? '城市：' + r.city_name : '',
      r.field_no ? '展位：' + r.field_no : '',
      publishType ? '招聘方式：' + publishType : '',
      !jobName ? '岗位未公布' : '',
      !requirements ? '要求未公布' : ''
    ].filter(Boolean).join('；');
    return {
      company,
      title: jobName,
      positions,
      requirements,
      applyMode,
      applyUrl: r.company_id ? `${BASE}/detail/company?company_id=${r.company_id}` : '',
      sourceUrl: r.company_id ? `${BASE}/detail/company?company_id=${r.company_id}` : '',
      sourceKey: String(r.jobfair_apply_job_id || r.company_id || company),
      confidence: 0.85,
      notes,
      rawText: JSON.stringify(r).slice(0, 1000)
    };
  }).filter(Boolean);
}

export default {
  id: 'swpu-jobfair',
  name: '西南石油大学 · 双选会',
  school: '西南石油大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网（双选会接口）',
  kind: '双选会',
  mode: 'json',
  enabled: true,
  acceptCode: [1],
  listUrl: BASE + '/module/getjobfairs?start=1&count=20&with_counts=1',
  maxPages: 100,
  collectLimit: 2000,
  capabilities: {list: 'json', detail: 'http', projects: 'api'},
  note: '云研系统双选会接口；参会单位与展位从 list_jobfair_company 读取。',
  parseList(_html, source, json) {
    return (json?.data?.list || []).map(item => {
      const day = String(item.meet_day || '');
      const time = String(item.meet_time || '09:00').slice(0, 5);
      const rawTitle = String(item.title || '').trim();
      const title = rawTitle.replace(/\s*[#＃]+\s*$/, '');
      if (!title || !day) return null;
      return {
        title,
        // 身份仍用源标题（含尾部 #），清洗只改展示，避免旧行被当成新活动重复入库。
        identityTitle: rawTitle,
        company: '',
        startAt: `${day}T${time}:00+08:00`,
        endAt: secondsIso(item.meet_end_time),
        venue: String(item.address || '').trim(),
        city: source.city,
        url: `${BASE}/detail/jobfair?id=${item.fair_id}`,
        kind: '双选会',
        sourceKey: String(item.fair_id || ''),
        notes: [
          item.organisers ? '主办：' + item.organisers : '',
          item.fact_c_count ? '已报名单位：' + item.fact_c_count : ''
        ].filter(Boolean).join('；'),
        projectCount: Number(item.fact_c_count) || 0
      };
    }).filter(Boolean);
  },
  async fetchList({source = this, limit, onLog = () => {}, fetchText: fetcher = fetchText} = {}) {
    const pageSize = 20;
    const cap = Math.max(1, Math.floor(Number(limit) || Number(source.collectLimit) || 2000));
    const maxPages = Math.max(1, Number(source.maxPages) || 100);
    let base = BASE;
    try { base = new URL(source.listUrl).origin; } catch { /* 保持默认域名 */ }
    const items = [];
    const seen = new Set();
    let pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = base + '/module/getjobfairs?start=' + page + '&count=' + pageSize + '&with_counts=1';
      const res = await fetcher(url, {headers: {referer: source.listUrl}, timeout: 20000, retries: 1});
      if (!res.ok) {
        const kind = res.reason === 'blocked' || res.reason === 'robots_disallowed' ? 'blocked' : 'network';
        throw new SourceError(kind, '双选会列表第 ' + page + ' 页失败：' + res.message);
      }
      let json;
      try { json = JSON.parse(res.text); } catch {
        throw new SourceError('parse', '双选会列表第 ' + page + ' 页不是 JSON');
      }
      const accepted = (source.acceptCode || [1]).map(Number);
      if (json.code && !accepted.includes(Number(json.code))) {
        throw new SourceError('changed', '双选会列表第 ' + page + ' 页返回 code=' + json.code + ' ' + (json.message || ''));
      }
      pages = page;
      const pageItems = source.parseList('', source, json);
      onLog?.({source: source.id, text: '双选会列表第 ' + page + ' 页：解析到 ' + pageItems.length + ' 条'});
      for (const item of pageItems) {
        const key = item.url || item.sourceKey || item.title + '|' + item.startAt;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        if (items.length >= cap) break;
      }
      if (pageItems.length < pageSize) break;
      if (items.length >= cap) break;
    }
    return {items, pages, pageCount: pages};
  },
  async fetchProjects(item, _event, options = {}) {
    const fetch = options.fetchText || fetchText;
    const base = options.base || BASE;
    let fairId = '';
    try { fairId = new URL(item.url).searchParams.get('id') || ''; } catch { /* 忽略 */ }
    if (!fairId) return {status: 'blocked', message: '双选会详情缺少 fair_id', projects: []};
    const pageSize = 50;
    // 接口按「岗位」返回记录，页数不能用单位数推算；以「不足一页」终止，上限放宽到 40 页（2000 条）。
    const maxPages = 40;
    const projects = [];
    const seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const url = `${base}/module/list_jobfair_company?is_total=0&start_page=1&start=${page}&count=${pageSize}&fair_id=${encodeURIComponent(fairId)}&type=`;
      const res = await fetch(url, {headers: {referer: item.url}, timeout: 20000, retries: 1});
      if (!res.ok) return {status: 'blocked', message: '参会单位接口失败：' + res.message, projects};
      let json;
      try { json = JSON.parse(res.text); } catch { return {status: 'blocked', message: '参会单位接口不是 JSON', projects}; }
      const pageProjects = parseCompanies(json);
      for (const p of pageProjects) {
        if (seen.has(p.sourceKey)) continue;
        seen.add(p.sourceKey);
        projects.push(p);
      }
      if (pageProjects.length < pageSize) break;
    }
    if (!projects.length) return {status: 'none', message: '接口可访问，但没有参会单位', projects: []};
    return {status: 'ok', message: `读取到 ${projects.length} 个参会单位`, projects};
  }
};
