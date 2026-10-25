// 电子科技大学就业网：Nuxt 服务端渲染背后的日历接口，无需登录即可取现场活动。
const BASE = 'https://jiuye.uestc.edu.cn/career';

function monthNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
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
        url: BASE + '/',
        kind: /双选会|招聘会/.test(title) ? '双选会' : '宣讲会',
        notes: [item.recruitmentTypeLabel ? '类型：' + item.recruitmentTypeLabel : '', item.occupationCategoryLabel ? '方向：' + item.occupationCategoryLabel : ''].filter(Boolean).join('；')
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
  listUrl: BASE + '/api/home/calendar?month=' + monthNow(),
  capabilities: {list: 'json', detail: 'none', projects: 'none'},
  note: 'Nuxt 页面背后的 onSiteCalendar 接口，取现场宣讲/招聘活动；需登录或详情单位时走公众号。',
  parseList(_html, _source, json) {
    return parseUestcCalendar(json);
  }
};
