import {join} from 'node:path';

// 读取本机招聘库：给智能体排行程用。
export async function events(args, ctx) {
  const dir = ctx.config?.recruitDir;
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库，请让用户先在“招聘日历”里采集。', events: []};
  const days = Math.min(90, Math.max(1, Number(args.days) || 30));
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const {buildSchedule, toMarkdown} = await import('../../recruit/schedule.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
    const to = new Date(Date.now() + days * 86400000).toISOString();
    const list = store.listEvents({from, to, limit: 300, school: args.school || undefined, kind: args.kind || undefined});
    const schedule = buildSchedule(list);
    return {
      status: list.length ? 'readable' : 'empty',
      notice: '数据来自本机已采集的高校就业网页面；未复核的条目请点来源链接确认，通勤为估算值。',
      count: list.length,
      stats: schedule.stats,
      markdown: list.length ? toMarkdown(schedule, {title: `未来 ${days} 天线下招聘安排`}) : '',
      events: list.slice(0, 60).map(e => ({school: e.school, title: e.title, company: e.company, kind: e.kind, startAt: e.startAt, endAt: e.endAt, venue: e.venue, sourceUrl: e.sourceUrl, verified: e.verified}))
    };
  } finally { store.close(); }
}
