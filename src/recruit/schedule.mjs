// 行程编排：按天分组、冲突检测、通勤估算、导出日历/表格/Markdown。
// 通勤时间为估算值（按校区坐标直线距离），只用于判断"赶不赶得上"，不替代地图导航。

const CAMPUS = [
  {match: /四川大学.*江安|江安校区/, name: '川大江安', lat: 30.556, lng: 103.995, city: '成都'},
  {match: /四川大学.*华西|华西校区/, name: '川大华西', lat: 30.641, lng: 104.064, city: '成都'},
  {match: /四川大学|望江校区/, name: '川大望江', lat: 30.630, lng: 104.083, city: '成都'},
  {match: /南开.*津南|津南校区/, name: '南开津南', lat: 38.995, lng: 117.345, city: '天津'},
  {match: /南开/, name: '南开八里台', lat: 39.107, lng: 117.170, city: '天津'},
  {match: /上海财经|武东路/, name: '上财', lat: 31.306, lng: 121.507, city: '上海'},
  {match: /中山大学|南校园/, name: '中大', lat: 23.097, lng: 113.298, city: '广州'},
  {match: /西南财经/, name: '西南财大', lat: 30.674, lng: 103.993, city: '成都'},
  {match: /四川农业大学.*成都|温江/, name: '川农成都', lat: 30.707, lng: 103.857, city: '成都'},
  {match: /四川农业大学.*雅安|雅安校区/, name: '川农雅安', lat: 29.987, lng: 103.001, city: '雅安'}
];

export function campusOf(venue = '') {
  return CAMPUS.find(c => c.match.test(String(venue))) || null;
}

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 返回 {minutes, basis}
export function estimateTravel(fromVenue, toVenue, fromCity = '', toCity = '') {
  if (fromCity && toCity && fromCity !== toCity) return {minutes: 180, basis: '跨城市，需高铁/飞机'};
  const a = campusOf(fromVenue), b = campusOf(toVenue);
  if (fromVenue && toVenue && fromVenue === toVenue) return {minutes: 0, basis: '同一场地'};
  if (a && b) {
    if (a.name === b.name) return {minutes: 5, basis: '同一校区步行'};
    const km = haversine(a, b);
    const minutes = Math.round(km / 25 * 60 + 15);
    return {minutes, basis: `直线 ${km.toFixed(1)}km，按 25km/h + 15 分钟缓冲估算`};
  }
  return {minutes: 45, basis: '场地未知，按同城 45 分钟保守估算'};
}

const pad = n => String(n).padStart(2, '0');

// 地图搜索链接：不依赖 API Key，手机/浏览器可直接打开高德。
export function mapUrlFor(event) {
  const keyword = [event.venue, event.school, event.city].filter(Boolean).join(' ').trim();
  const city = event.city && event.city !== '全国' ? event.city : '';
  return 'https://uri.amap.com/search?keyword=' + encodeURIComponent(keyword || event.title || '招聘会') + (city ? '&city=' + encodeURIComponent(city) : '');
}

function china(date) {
  const d = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  return {y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes()};
}
export function fmtWhen(iso) {
  if (!iso) return '';
  const c = china(iso);
  return `${c.y}-${pad(c.m)}-${pad(c.d)} ${pad(c.h)}:${pad(c.mi)}`;
}
const endOf = e => e.endAt || new Date(new Date(e.startAt).getTime() + 90 * 60000).toISOString();

export function buildSchedule(events, {homeCity = '成都'} = {}) {
  const groups = new Map();
  for (const e of [...events].sort((x, y) => x.startAt.localeCompare(y.startAt))) {
    const day = china(e.startAt);
    const key = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({...e, mapUrl: mapUrlFor(e)});
  }
  const days = [];
  for (const [date, list] of groups) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    const items = [];
    let previous = null;
    for (const event of list) {
      const start = new Date(event.startAt).getTime();
      const end = new Date(endOf(event)).getTime();
      let conflict = false, travel = null, warning = '';
      if (previous) {
        const prevEnd = new Date(endOf(previous)).getTime();
        const sameCity = (previous.city || '') === (event.city || '');
        travel = estimateTravel(previous.venue, event.venue, previous.city, event.city);
        const gap = Math.round((start - prevEnd) / 60000);
        if (!sameCity) { conflict = false; warning = `同日异地（${previous.city || '未知'} → ${event.city || '未知'}），需取舍或改天`; }
        else if (start < prevEnd) { conflict = true; warning = '与上一场时间重叠'; }
        else if (gap >= 0 && gap < travel.minutes) warning = `两场间隔 ${gap} 分钟，小于估算通勤 ${travel.minutes} 分钟`;
        else warning = `两场间隔 ${gap} 分钟`;
      } else {
        travel = estimateTravel('', event.venue, homeCity, event.city);
        warning = event.venue ? '' : '地点未公布，需到原链接确认';
      }
      items.push({event, conflict, travel, warning});
      previous = event;
      void end;
    }
    days.push({date, weekday: '日一二三四五六'[new Date(date + 'T00:00:00+08:00').getDay()], items});
  }
  const conflicts = days.flatMap(d => d.items.filter(i => i.conflict)).length;
  const risky = days.flatMap(d => d.items.filter(i => !i.conflict && /小于估算通勤/.test(i.warning))).length;
  return {days, stats: {days: days.length, events: events.length, conflicts, risky}};
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsTime(iso) {
  const c = china(iso);
  return `${c.y}${pad(c.m)}${pad(c.d)}T${pad(c.h)}${pad(c.mi)}00`;
}
function fold(line) {
  if (line.length <= 73) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length) { parts.push(' ' + rest.slice(0, 72)); rest = rest.slice(72); }
  return parts.join('\r\n');
}

export function toICS(events, {calendarName = '职向 · 线下招聘行程'} = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ZhiXiang//Campus Recruit//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(calendarName), 'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE'
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  for (const e of [...events].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + e.id + '@zhixiang.local',
      'DTSTAMP:' + stamp,
      'DTSTART;TZID=Asia/Shanghai:' + icsTime(e.startAt),
      'DTEND;TZID=Asia/Shanghai:' + icsTime(endOf(e)),
      'SUMMARY:' + icsEscape(`[${e.school}] ${e.title}`),
      'LOCATION:' + icsEscape([e.venue, e.address].filter(Boolean).join(' ')),
      'DESCRIPTION:' + icsEscape([
        e.company ? '单位：' + e.company : '',
        e.kind ? '类型：' + e.kind : '',
        e.interviewStage ? '招聘环节：' + e.interviewStage : '',
        e.interviewType && e.interviewType !== e.interviewStage ? '面试类型：' + e.interviewType : '',
        e.industry ? '行业：' + e.industry : '',
        e.applyMode ? '投递：' + e.applyMode : '',
        '地图：' + (e.mapUrl || mapUrlFor(e)),
        '来源：' + (e.sourceUrl || ''),
        '信息核对：' + (e.verified ? '已复核' : '待复核（置信度 ' + Math.round((e.confidence || 0) * 100) + '%）')
      ].filter(Boolean).join('\n')),
      'URL:' + (e.sourceUrl || ''),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function toCSV(events) {
  const head = ['日期', '开始', '结束', '学校', '城市', '类型', '招聘环节', '面试类型', '活动名称', '单位', '地点', '地图链接', '行业', '投递方式', '来源链接', '置信度', '是否复核'];
  const rows = [...events].sort((a, b) => a.startAt.localeCompare(b.startAt)).map(e => {
    const c = china(e.startAt), ce = china(endOf(e));
    return [
      `${c.y}-${pad(c.m)}-${pad(c.d)}`, `${pad(c.h)}:${pad(c.mi)}`, `${pad(ce.h)}:${pad(ce.mi)}`,
      e.school, e.city, e.kind, e.interviewStage || '', e.interviewType || '', e.title, e.company, e.venue, e.mapUrl || mapUrlFor(e), e.industry, e.applyMode, e.sourceUrl,
      Math.round((e.confidence || 0) * 100) + '%', e.verified ? '是' : '否'
    ];
  });
  const quote = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '\uFEFF' + [head, ...rows].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

export function toMarkdown(schedule, {title = '线下招聘时间安排表'} = {}) {
  const out = ['# ' + title, '', `> 共 ${schedule.stats.events} 场，覆盖 ${schedule.stats.days} 天；冲突 ${schedule.stats.conflicts} 处，赶场风险 ${schedule.stats.risky} 处。`, ''];
  for (const day of schedule.days) {
    out.push(`## ${day.date}（周${day.weekday}）`, '', '| 时间 | 活动 | 单位 | 环节 | 地点 | 通勤 | 提示 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const {event, travel, warning, conflict} of day.items) {
      const c = china(event.startAt), ce = china(endOf(event));
      const stage = [...new Set([event.interviewStage, event.interviewType].filter(Boolean))].join(' / ') || '-';
      out.push(`| ${pad(c.h)}:${pad(c.mi)}-${pad(ce.h)}:${pad(ce.mi)} | ${event.title} | ${event.company || '-'} | ${stage} | ${event.venue ? `[${event.venue}](${event.mapUrl || mapUrlFor(event)})` : '待确认'} | ${travel ? travel.minutes + ' 分钟' : '-'} | ${conflict ? '⚠ 时间冲突' : warning || '-'} |`);
    }
    out.push('');
  }
  out.push('---', '', '说明：时间为北京时间；通勤为按校区坐标的估算值，出行前请用地图复核；未标注"已复核"的信息请点开来源链接确认。');
  return out.join('\n');
}

export function toMarkdownFree(events) {
  return toMarkdown(buildSchedule(events));
}
