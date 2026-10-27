// 日期用北京时间，避免跨时区把"今天"算错。
function todayChina() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export default {
  id: 'swjtu-xjh',
  name: '西南交通大学 · 宣讲会/双选会日历',
  school: '西南交通大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网（日历接口）',
  kind: '宣讲会',
  mode: 'json',
  capabilities: {list: 'json', detail: 'http', projects: 'none'},
  enabled: true,
  listUrl: 'https://jiuye.swjtu.edu.cn/career/index/common/jyrl',
  request: {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest'},
    body: () => 'date=' + todayChina()
  },
  note: "双选会详情“已报名单位”在前端被注释；项目暂不支持，公众号兜底。",
  parseList(_html, source, json) {
    const today = source?.today || todayChina();
    const out = [];
    for (const group of json?.data || []) {
      for (const item of group.con || []) {
        const mark = String(item.mark || '').trim();
        if (!mark) continue;
        const startAt = mark.replace(' ', 'T') + ':00+08:00';
        if (mark.slice(0, 10) < today) continue;
        out.push({
          title: String(item.xjhzt || item.con || '').trim(),
          company: '',
          startAt,
          endAt: '',
          venue: String(item.cdmc || '').trim(),
          city: source.city,
          url: 'https://jiuye.swjtu.edu.cn/career/' + String(item.a || '').replace(/^\/+/, ''),
          kind: item.type === 'zph' ? '双选会' : '宣讲会'
        });
      }
    }
    return out.filter(x => x.title && x.startAt);
  }
};
