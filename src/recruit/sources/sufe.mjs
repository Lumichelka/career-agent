import {DAY, parseTimeRange} from './common.mjs';

export default {
  id: 'sufe-xjh',
  name: '上海财经大学 · 宣讲会（JSON 接口）',
  school: '上海财经大学',
  city: '上海',
  category: '财经强校',
  channel: '就业信息网（数据接口）',
  kind: '宣讲会',
  mode: 'json',
  enabled: true,
  listUrl: 'https://career.sufe.edu.cn/career/xjhxx/search/01/1/10',
  // 匿名访问每页最多 10 条（20 条起要求登录），因此按页翻。
  pageUrl: p => `https://career.sufe.edu.cn/career/xjhxx/search/01/${p}/10`,
  maxPages: 3,
  request: {method: 'POST', headers: {'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest'}, body: '{}'},
  note: '页面本身是 JS 渲染，但底层 JSON 接口可直连：返回单位、日期、时段、场地、行业、规模。',
  parseList(_html, _source, json) {
    const list = json?.data?.list || [];
    return list.map(r => {
      const date = String(r.jbrq || '');
      const times = parseTimeRange(r.jbsjdmc) || (r.jbsjdmc ? [String(r.jbsjdmc).slice(0, 5), ''] : null);
      return {
        title: String(r.xjhzt || r.dwmc || '').trim(),
        company: String(r.dwmc || '').trim(),
        startAt: date ? DAY(date, times?.[0] || '09:00') : '',
        endAt: times?.[1] ? DAY(date, times[1]) : '',
        venue: String(r.cddz || r.cdmc || '').trim(),
        city: String(r.szsmc || '上海'),
        industry: String(r.hyyjmc || ''),
        companySize: String(r.rsgmmc || ''),
        url: 'https://career.sufe.edu.cn/career/xjhxx/view/' + r.xjhid,
        kind: '宣讲会'
      };
    }).filter(x => x.title && x.startAt);
  }
};
