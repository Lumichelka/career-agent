// 西南石油大学就业网（云研系统）：列表接口 /module/getcareers，无需登录。
const BASE = 'https://jyzx.swpu.edu.cn';
const COMMON = 'k=&type=&day=&panel_name=&panel_id=&professionals=&work_city=&is_yun_career=&status=&order=';

function isoFromSeconds(seconds) {
  const n = Number(seconds);
  if (!n) return '';
  return new Date(n * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

export default {
  id: 'swpu-xjh',
  name: '西南石油大学 · 宣讲会/双选会',
  school: '西南石油大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网（列表接口）',
  kind: '宣讲会',
  mode: 'json',
  enabled: true,
  acceptCode: [1],
  listUrl: BASE + '/module/getcareers?start=1&count=20&with_counts=1&' + COMMON,
  pageUrl: p => BASE + '/module/getcareers?start=' + p + '&count=20&with_counts=1&' + COMMON,
  maxPages: 3,
  note: '云研系统列表接口，含单位、起止时间、校区教室、行业与规模；一次翻页 20 条。',
  parseList(_html, source, json) {
    return (json?.data?.list || []).map(item => {
      const startAt = isoFromSeconds(item.a_meet_time);
      if (!item.meet_name || !startAt) return null;
      const venue = String(item.address || item.room || '').trim();
      return {
        title: String(item.meet_name || '').trim(),
        company: String(item.company_name || '').trim(),
        startAt,
        endAt: isoFromSeconds(item.a_meet_end_time),
        venue,
        city: /南充/.test(venue) ? '南充' : source.city,
        url: BASE + '/detail/career?id=' + item.career_talk_id,
        kind: /双选|招聘会/.test(String(item.recruit_type || '')) ? '双选会' : '宣讲会',
        industry: String(item.industry_category || '').trim(),
        companySize: String(item.scale || '').trim(),
        notes: item.recruit_type ? '招聘类型：' + item.recruit_type : ''
      };
    }).filter(Boolean);
  }
};
