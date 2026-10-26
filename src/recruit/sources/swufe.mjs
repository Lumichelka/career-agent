import {parseDateText, strip} from './common.mjs';

// 站点 robots.txt 为 Disallow: /，按合规要求不自动采集；保留解析器，等站点放开或走人工转发。
export default {
  id: 'swufe-xjh',
  name: '西南财经大学 · 双选会/招聘会',
  school: '西南财经大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网',
  kind: '双选会',
  mode: 'static',
  capabilities: {list: 'static', detail: 'none', projects: 'none'},
  enabled: false,
  listUrl: 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm',
  sourceCheck: {enabled: true, detailPattern: 'jobfair-show-\\d+\\.htm', participantTab: '参会企业', participantRequired: true},
  note: "robots 禁止抓取；只保留公众号作为学校来源。",
  fallback: '官方微信公众号「西南财经大学就业指导中心」+ 人工转发链接',
  parseList(html, source) {
    const out = [];
    const re = /<div class="tit link_gray6"><a href="(\/jobfair\/jobfair-show-\d+\.htm)">([\s\S]*?)<\/a><\/div>\s*<div class="txt substring">举办时间：([^<]*)<\/div>\s*<div class="txt substring">举办地点：([^<]*)<\/div>/g;
    for (const m of html.matchAll(re)) {
      const date = parseDateText(m[3]);
      if (!date) continue;
      const time = (m[3].match(/(\d{1,2})时(?:(\d{1,2})分)?/) || []);
      const hh = time[1] ? String(time[1]).padStart(2, '0') : '09';
      const mm = time[2] ? String(time[2]).padStart(2, '0') : '00';
      const venue = strip(m[4]).split(/[，。;；]/)[0].trim();
      out.push({
        title: strip(m[2]),
        company: '',
        startAt: `${date}T${hh}:${mm}:00+08:00`,
        endAt: '',
        venue,
        city: source.city,
        url: new URL(m[1], source.listUrl).href,
        kind: '双选会'
      });
    }
    return out;
  }
};
