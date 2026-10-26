import {createHash} from 'node:crypto';
import {DAY, parseDateText, parseTimeRange, strip} from './common.mjs';
import {fetchText} from '../fetch.mjs';

const BASE = 'https://jy.scu.edu.cn';

export function parseCorporations(html, base = BASE) {
  const out = [];
  const re = /<li>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
  for (const m of String(html || '').matchAll(re)) {
    const raw = strip(m[2]).replace(/\u00a0/g, ' ');
    const name = raw.split('【')[0].trim();
    if (!name) continue;
    const meta = (raw.match(/【([^】]+)】/) || [])[1] || '';
    out.push({
      company: name.slice(0, 120),
      title: '',
      positions: '',
      applyMode: '现场',
      sourceUrl: new URL(m[1], base).href,
      sourceKey: (new URL(m[1], base).searchParams.get('data') || name).slice(0, 200),
      notes: meta ? '单位信息：' + meta : '',
      confidence: 0.8
    });
  }
  return out;
}

// 详情页「职位信息」里的单个 job-table：表头 6 列 + 后续「标签：值」行。
function parseJobTable(tbody) {
  const rows = [...String(tbody || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const data = {};
  let name = '', type = '', nature = '', degree = '', count = '', salary = '';
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => strip(m[1]));
    if (!cells.length) continue;
    const isHeader = /<th/i.test(row);
    if (!isHeader && cells.length >= 6) {
      // 6 列数据行：职位名称 / 类型 / 性质 / 学历 / 人数 / 薪资
      [name, type, nature, degree, count, salary] = cells;
      continue;
    }
    if (!isHeader && cells.length >= 2) {
      const label = cells[0];
      const value = cells.slice(1).join(' ');
      data[label] = value;
    }
  }
  if (!name) return null;
  return {
    name, type, nature, degree, count, salary,
    major: data['专业'] || '',
    address: data['工作地址'] || '',
    requirement: data['职位要求'] || '',
    intro: data['职位简介'] || '',
    duties: data['岗位职责'] || ''
  };
}

// 详情页 → {jobs: 职位信息数组, email: 投递邮箱}；读不到返回空数组/空邮箱，不编造。
export function parseCorporationDetail(html) {
  const doc = String(html || '');
  const jobs = [];
  const tableRe = /<table class="job-table">([\s\S]*?)<\/table>/g;
  for (const m of doc.matchAll(tableRe)) {
    const job = parseJobTable(m[1]);
    if (job) jobs.push(job);
  }
  const email = (doc.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
  return {jobs, email};
}

// 岗位键只由岗位内容决定：岗位重排/插队不会把旧键指向另一个岗位。
function jobSourceKey(corp, job) {
  const base = String(corp.sourceKey || corp.company || '');
  const hash = createHash('sha1').update(JSON.stringify(job ?? {})).digest('hex').slice(0, 16);
  return (base ? base + '#' : '') + hash;
}

// 单位（列表行）+ 详情 → 1..N 个项目：有职位按职位拆，读不到退回单位级并标「未公布」。
export function mergeCorporationDetail(corp, detail = {}) {
  const jobs = Array.isArray(detail.jobs) ? detail.jobs : [];
  const email = detail.email || '';
  const applyMode = email ? '邮箱投递' : (corp.applyMode || '现场');
  const applyUrl = email ? 'mailto:' + email : '';
  if (!jobs.length) {
    return [{
      company: corp.company,
      title: '',
      positions: '',
      requirements: '',
      applyMode,
      applyUrl,
      sourceUrl: corp.sourceUrl || '',
      sourceKey: corp.sourceKey || corp.company || '',
      notes: [corp.notes, '岗位/要求未公布'].filter(Boolean).join('；'),
      confidence: corp.confidence ?? 0.8
    }];
  }
  return jobs.map(j => {
    const positions = [j.name, j.type ? '类型 ' + j.type : '', j.salary ? '薪资 ' + j.salary : '', j.count ? '招聘 ' + j.count + ' 人' : '', j.duties].filter(Boolean).join('；');
    const requirements = [
      j.degree ? '学历 ' + j.degree : '',
      j.major && j.major !== '不限' ? '专业 ' + j.major : '',
      j.requirement
    ].filter(Boolean).join('；');
    return {
      company: corp.company,
      title: j.name,
      positions,
      requirements,
      applyMode,
      applyUrl,
      sourceUrl: corp.sourceUrl || '',
      sourceKey: jobSourceKey(corp, j),
      notes: corp.notes || '',
      confidence: 0.8,
      rawText: JSON.stringify(j).slice(0, 1000)
    };
  });
}

export default {
  id: 'scu-jobfair',
  name: '四川大学 · 双选会',
  school: '四川大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网',
  kind: '双选会',
  mode: 'static',
  enabled: true,
  capabilities: {list: 'static', detail: 'http', projects: 'api'},
  listUrl: 'https://jy.scu.edu.cn/index/index/jobfair.html',
  note: '线下双选会列表；参会单位通过 jobfaircorporationlist 的 POST 接口读取，岗位/要求逐单位抓详情页补充。',
  parseList(html, source) {
    const out = [];
    const re = /<li><span class="list1_time">([^<]+)<\/span><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(re)) {
      const date = parseDateText(m[1]);
      const times = parseTimeRange(m[1]) || (m[1].match(/(\d{1,2}):(\d{2})/) ? [m[1].match(/(\d{1,2}):(\d{2})/)[0], ''] : null);
      if (!date) continue;
      const title = strip(m[3]);
      out.push({
        title,
        company: '',
        startAt: DAY(date, times?.[0] || '09:00'),
        endAt: times?.[1] ? DAY(date, times[1]) : '',
        venue: title.includes('江安') ? '四川大学江安校区' : title.includes('华西') ? '四川大学华西校区' : '四川大学望江校区',
        city: source.city,
        url: new URL(m[2], source.listUrl).href,
        kind: '双选会'
      });
    }
    return out;
  },
  async fetchProjects(item, _event, options = {}) {
    const fetch = options.fetchText || fetchText;
    const base = options.base || BASE;
    // 逐单位抓详情页有成本：限量，超出部分退回单位级「未公布」；fetchText 内部已按源限速。
    const detailLimit = Number(options.detailLimit) > 0 ? Number(options.detailLimit) : 40;
    let type = '';
    try { type = new URL(item.url).searchParams.get('data') || ''; } catch { /* 忽略 */ }
    if (!type) return {status: 'blocked', message: '双选会链接缺少 data 参数', projects: []};
    const corporations = [];
    const seen = new Set();
    for (let page = 1; page <= 10; page++) {
      const body = new URLSearchParams({page: String(page), type});
      const res = await fetch(`${base}/index/index/getjobfaircorporationlistdata.html`, {
        method: 'POST', body, timeout: 20000, retries: 1,
        headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: item.url}
      });
      if (!res.ok) return {status: 'blocked', message: '参会单位接口失败：' + res.message, projects: []};
      const pageCorps = parseCorporations(res.text, base);
      for (const c of pageCorps) {
        if (seen.has(c.sourceKey)) continue;
        seen.add(c.sourceKey);
        corporations.push(c);
      }
      if (!pageCorps.length) break;
    }
    if (!corporations.length) return {status: 'none', message: '接口可访问，但没有参会单位', projects: []};
    const projects = [];
    for (const [index, corp] of corporations.entries()) {
      let detail = {jobs: [], email: ''};
      // 详情抓取有成本：只对前 detailLimit 个单位抓；其余退回单位级「未公布」，不丢单位。
      if (index < detailLimit) {
        try {
          const res = await fetch(corp.sourceUrl, {timeout: 15000, retries: 0});
          if (res.ok) detail = parseCorporationDetail(res.text);
        } catch { /* 详情页失败 → 未公布 */ }
      }
      projects.push(...mergeCorporationDetail(corp, detail));
    }
    const fallback = Math.max(0, corporations.length - detailLimit);
    return {
      status: 'ok',
      message: `读取到 ${projects.length} 个招聘项目` + (fallback ? `（${fallback} 个单位未抓详情，已按单位级「未公布」保留）` : ''),
      projects
    };
  }
};
