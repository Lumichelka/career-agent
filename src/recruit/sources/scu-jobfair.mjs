import {DAY, parseDateText, parseTimeRange, strip} from './common.mjs';
import {fetchText} from '../fetch.mjs';

const BASE = 'https://jy.scu.edu.cn';

export function parseCorporations(html) {
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
      sourceUrl: new URL(m[1], BASE).href,
      sourceKey: (new URL(m[1], BASE).searchParams.get('data') || name).slice(0, 200),
      notes: meta ? '单位信息：' + meta : '',
      confidence: 0.8
    });
  }
  return out;
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
  note: '线下双选会列表；参会单位通过 jobfaircorporationlist 的 POST 接口读取。',
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
  async fetchProjects(item) {
    let type = '';
    try { type = new URL(item.url).searchParams.get('data') || ''; } catch { /* 忽略 */ }
    if (!type) return {status: 'blocked', message: '双选会链接缺少 data 参数', projects: []};
    const projects = [];
    const seen = new Set();
    for (let page = 1; page <= 10; page++) {
      const body = new URLSearchParams({page: String(page), type});
      const res = await fetchText(`${BASE}/index/index/getjobfaircorporationlistdata.html`, {
        method: 'POST', body, timeout: 20000, retries: 1,
        headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: item.url}
      });
      if (!res.ok) return {status: 'blocked', message: '参会单位接口失败：' + res.message, projects};
      const pageProjects = parseCorporations(res.text);
      for (const p of pageProjects) {
        if (seen.has(p.sourceKey)) continue;
        seen.add(p.sourceKey);
        projects.push(p);
      }
      if (!pageProjects.length) break;
    }
    if (!projects.length) return {status: 'none', message: '接口可访问，但没有参会单位', projects: []};
    return {status: 'ok', message: `读取到 ${projects.length} 个参会单位`, projects};
  }
};
