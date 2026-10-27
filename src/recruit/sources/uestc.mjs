// 电子科技大学就业网：Nuxt 服务端渲染背后的日历接口，无需登录即可取现场活动。
import {fetchText} from '../fetch.mjs';
import {SourceError} from './error.mjs';

const BASE = 'https://jiuye.uestc.edu.cn/career';

// 按北京时间取相对月份（offset=0 本月，1 下月）；先落到 1 号，避免 31 号加一个月溢出。
export function monthOffset(offset = 0, now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Number(offset || 0), 1));
  return month.toISOString().slice(0, 7);
}

export function parseUestcCalendar(json) {
  const days = json?.data?.onSiteCalendar?.data || {};
  const out = [];
  for (const bucket of Object.values(days)) {
    for (const item of bucket?.data || []) {
      const rawDate = String(item.recruitmentDate || '').slice(0, 19);
      if (!rawDate) continue;
      const company = String(item.companyName || '').trim();
      const title = String(item.title || company || '').trim();
      if (!title) continue;
      const endTime = String(item.endTime || '').slice(0, 8);
      out.push({
        title,
        company,
        startAt: rawDate.replace(' ', 'T') + '+08:00',
        endAt: endTime ? rawDate.slice(0, 10) + 'T' + endTime + '+08:00' : '',
        venue: String(item.recruitmentLocation || '').trim(),
        city: '成都',
        url: '',
        kind: /双选会|招聘会/.test(title) ? '双选会' : '宣讲会',
        sourceKey: String(item.id || ''),
        notes: ['无详情链接', item.recruitmentTypeLabel ? '类型：' + item.recruitmentTypeLabel : '', item.occupationCategoryLabel ? '方向：' + item.occupationCategoryLabel : ''].filter(Boolean).join('；')
      });
    }
  }
  return out;
}

export default {
  id: 'uestc-xjh',
  name: '电子科技大学 · 现场招聘',
  school: '电子科技大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网（日历接口）',
  kind: '宣讲会',
  mode: 'json',
  enabled: true,
  acceptCode: [0],
  collectLimit: 500,
  collectMonths: 2,
  listUrl: BASE + '/api/home/calendar?month=' + monthOffset(0),
  capabilities: {list: 'json', detail: 'none', projects: 'none'},
  note: 'Nuxt 页面背后的 onSiteCalendar 接口，取现场宣讲/招聘活动；需登录或详情单位时走公众号。',
  parseList(_html, _source, json) {
    return parseUestcCalendar(json);
  },
  // 日历一次只返回一个月，且按时间升序；同时取本月和下月，合并去重后按开始时间排序。
  async fetchList({source = this, limit, onLog = () => {}, fetchText: fetcher = fetchText} = {}) {
    const cap = Math.max(1, Math.floor(Number(limit) || Number(source.collectLimit) || 500));
    const months = Math.max(1, Math.min(3, Number(source.collectMonths) || 2));
    const items = [];
    const seen = new Set();
    let pages = 0;
    for (let offset = 0; offset < months; offset++) {
      const month = monthOffset(offset);
      const url = new URL(source.listUrl);
      url.searchParams.set('month', month);
      const res = await fetcher(url.toString(), {headers: {referer: source.listUrl}, timeout: 20000, retries: 1});
      if (!res.ok) {
        const kind = res.reason === 'blocked' || res.reason === 'robots_disallowed' ? 'blocked' : 'network';
        throw new SourceError(kind, '电子科大日历 ' + month + ' 抓取失败：' + res.message);
      }
      let json;
      try { json = JSON.parse(res.text); } catch {
        throw new SourceError('parse', '电子科大日历 ' + month + ' 不是 JSON');
      }
      const accepted = (source.acceptCode || [0]).map(Number);
      if (json.code !== undefined && json.code !== null && !accepted.includes(Number(json.code))) {
        throw new SourceError('changed', '电子科大日历 ' + month + ' 返回 code=' + json.code + ' ' + (json.message || ''));
      }
      pages++;
      const pageItems = source.parseList('', source, json) || [];
      onLog?.({source: source.id, text: '日历 ' + month + '：解析到 ' + pageItems.length + ' 条'});
      for (const item of pageItems) {
        const key = item.sourceKey || item.title + '|' + item.startAt;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }
    items.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
    return {items: items.slice(0, cap), pages, pageCount: pages};
  }
};
