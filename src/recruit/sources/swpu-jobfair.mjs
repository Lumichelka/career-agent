// 西南石油大学双选会：列表接口 + 参会单位接口（云研系统，均无需登录）。
import {fetchText} from '../fetch.mjs';

const BASE = 'https://jyzx.swpu.edu.cn';

function secondsIso(seconds) {
  const n = Number(seconds);
  if (!n) return '';
  return new Date(n * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

export function parseCompanies(json) {
  return (json?.data || []).map(r => {
    const company = String(r.company_name || '').trim();
    if (!company) return null;
    const notes = [
      r.industry_category ? '行业：' + r.industry_category : '',
      r.scale ? '规模：' + r.scale : '',
      r.city_name ? '城市：' + r.city_name : '',
      r.field_no ? '展位：' + r.field_no : ''
    ].filter(Boolean).join('；');
    return {
      company,
      title: String(r.job_recruitment || '').trim(),
      positions: String(r.professionals || '').trim(),
      applyMode: '现场',
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
  maxPages: 1,
  capabilities: {list: 'json', detail: 'http', projects: 'api'},
  note: '云研系统双选会接口；参会单位与展位从 list_jobfair_company 读取。',
  parseList(_html, source, json) {
    return (json?.data?.list || []).map(item => {
      const day = String(item.meet_day || '');
      const time = String(item.meet_time || '09:00').slice(0, 5);
      if (!item.title || !day) return null;
      return {
        title: String(item.title || '').trim(),
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
  async fetchProjects(item) {
    let fairId = '';
    try { fairId = new URL(item.url).searchParams.get('id') || ''; } catch { /* 忽略 */ }
    if (!fairId) return {status: 'blocked', message: '双选会详情缺少 fair_id', projects: []};
    const pageSize = 50;
    const maxPages = Math.min(6, Math.max(1, Math.ceil((Number(item.projectCount) || 0) / pageSize)));
    const projects = [];
    const seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const url = `${BASE}/module/list_jobfair_company?is_total=0&start_page=1&start=${page}&count=${pageSize}&fair_id=${encodeURIComponent(fairId)}&type=`;
      const res = await fetchText(url, {headers: {referer: item.url}, timeout: 20000, retries: 1});
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
