import {parseDateText} from './common.mjs';

// schoolBranch 1/2/3 对应雅安/成都/都江堰（按站点栏目顺序；如有误请点原链接核对）
const CAMPUS = {1: {name: '雅安校区', city: '雅安'}, 2: {name: '成都校区', city: '成都'}, 3: {name: '都江堰校区', city: '都江堰'}};

export default {
  id: 'sicau-xjh',
  name: '四川农业大学 · 校园招聘会',
  school: '四川农业大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网（数据接口）',
  kind: '宣讲会',
  mode: 'json',
  enabled: true,
  listUrl: 'https://job.sicau.edu.cn/job/website/recruitmentList?pageNo=1&pageSize=20',
  pageUrl: p => `https://job.sicau.edu.cn/job/website/recruitmentList?pageNo=${p}&pageSize=20`,
  maxPages: 3,
  note: '列表是前端异步加载，但底层 JSON 接口可直接翻页；含单位、起止时间、地点、校区。',
  parseList(_html, _source, json) {
    return (json?.data || []).map(r => {
      const campus = CAMPUS[Number(r.schoolBranch)] || {};
      const startAt = r.beginDate ? String(r.beginDate).replace(' ', 'T') + '+08:00' : '';
      const endAt = r.endDate ? String(r.endDate).replace(' ', 'T') + '+08:00' : '';
      return {
        title: String(r.title || '').trim(),
        company: String(r.entName || '').trim(),
        startAt,
        endAt,
        venue: [campus.name, String(r.place || '').trim()].filter(Boolean).join(' '),
        city: campus.city || '成都',
        url: `https://job.sicau.edu.cn/employment/zpxx/xyxjh/meeting_details/index.html?id=${r.recruitmentId}&enid=${r.entId || ''}&postid=${r.posterId || ''}`,
        kind: '宣讲会',
        notes: r.isExpired ? '来源标记已过期' : ''
      };
    }).filter(x => x.title && x.startAt);
  }
};
