import {DAY, parseDateText, parseTimeRange, strip} from './common.mjs';

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
  listUrl: 'https://jy.scu.edu.cn/index/index/jobfair.html',
  note: '线下双选会列表，含开始时间与活动名称。',
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
  }
};
