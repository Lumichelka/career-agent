import {DAY, parseDateText, parseTimeRange, strip, guessKind} from './common.mjs';

export default {
  id: 'nankai-recruitment',
  name: '南开大学 · 双选会信息',
  school: '南开大学',
  city: '天津',
  category: '财经强校',
  channel: '就业信息网',
  kind: '双选会',
  mode: 'static',
  capabilities: {list: 'static', detail: 'http', projects: 'none'},
  enabled: true,
  listUrl: 'https://career.nankai.edu.cn/recruitment/index.html',
  detail: true,
  note: "双选会详情是邀请函，无参会单位表；项目暂不支持。",
  parseList(html, source) {
    const out = [];
    const re = /<li>\s*<a href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>\s*<span>([^<]*)<\/span>/g;
    for (const m of html.matchAll(re)) {
      const date = parseDateText(m[3]);
      const title = strip(m[2]);
      if (!date || !title) continue;
      out.push({title, company: '', startAt: DAY(date, '09:00'), endAt: '', venue: '', city: source.city, url: new URL(m[1], source.listUrl).href, kind: guessKind(title, '双选会')});
    }
    return out;
  },
  parseDetail(text) {
    const t = String(text || '');
    const date = parseDateText((t.match(/时间[:：]\s*(20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2})/) || [])[1] || '');
    const timeText = (t.match(/(\d{1,2}:\d{2}\s*[-~—至到]\s*\d{1,2}:\d{2})/) || [])[1] || '';
    const times = parseTimeRange(timeText);
    const venue = ((t.match(/地点[:：]\s*([^\s，。;；]{2,60})/) || [])[1] || '').trim();
    return {date, startTime: times?.[0] || '', endTime: times?.[1] || '', venue};
  }
};
