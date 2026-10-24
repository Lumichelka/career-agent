import {DAY, strip, guessCompany} from './common.mjs';

export default {
  id: 'sysu-home',
  name: '中山大学 · 首页宣讲会摘要',
  school: '中山大学',
  city: '广州',
  category: '财经强校',
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'static',
  enabled: true,
  listUrl: 'https://career.sysu.edu.cn/',
  note: '首页可见若干条宣讲会与日期；详情页需要统一身份认证，因此只收录标题与日期。',
  parseList(html, source) {
    const out = [];
    const re = /href="(\/teachin\/view\/id\/\d+)"[^>]*>([^<]{4,100})<\/a>[\s\S]{0,240}?(20\d{2}-\d{2}-\d{2})/g;
    for (const m of html.matchAll(re)) {
      const title = strip(m[2]);
      out.push({title, company: guessCompany(title), startAt: DAY(m[3], '09:00'), endAt: '', venue: '', city: source.city, url: new URL(m[1], source.listUrl).href, kind: '宣讲会'});
    }
    return out;
  }
};
