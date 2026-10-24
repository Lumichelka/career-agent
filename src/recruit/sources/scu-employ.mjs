import {DAY, parseDateText, parseTimeRange, strip} from './common.mjs';

export default {
  id: 'scu-employ',
  name: '四川大学 · 校园宣讲会',
  school: '四川大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'static',
  enabled: true,
  listUrl: 'https://jy.scu.edu.cn/index/index/employ.html',
  note: '线下宣讲（未开始）列表，含举办日期/地点/单位名称，静态 HTML 可直取。',
  parseList(html, source) {
    const out = [];
    const re = /<li>\s*<span class="list1_time">([^<]+)<\/span>\s*<span class="list1_time">([^<]+)<\/span>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(re)) {
      const date = parseDateText(m[1]);
      const times = parseTimeRange(m[1]);
      if (!date) continue;
      const title = strip(m[4]);
      out.push({
        title,
        company: '',
        startAt: DAY(date, times ? times[0] : '09:00'),
        endAt: times ? DAY(date, times[1]) : '',
        venue: strip(m[2]),
        city: source.city,
        url: new URL(m[3], source.listUrl).href,
        kind: '宣讲会'
      });
    }
    return out;
  }
};
