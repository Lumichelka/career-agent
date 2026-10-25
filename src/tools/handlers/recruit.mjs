import {join} from 'node:path';
import {SOURCES, sourceHealth} from '../../recruit/sources/index.mjs';

function ctxDir(ctx) { return ctx.config?.recruitDir; }

// 项目列表：日历/来源数据的项目视角，供 Agent 选项目后研究。
export async function projects(args, ctx) {
  const dir = ctxDir(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库。', projects: []};
  const days = Math.min(180, Math.max(1, Number(args.days) || 30));
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
    const to = new Date(Date.now() + days * 86400000).toISOString();
    const events = store.listEvents({from, to, limit: 300, school: args.school || undefined, withProjects: true});
    const q = String(args.q || '').trim().toLowerCase();
    const company = String(args.company || '').trim().toLowerCase();
    const out = [];
    for (const e of events) {
      for (const p of e.projects || []) {
        if (company && !String(p.company || '').toLowerCase().includes(company)) continue;
        if (q && !(p.company + ' ' + p.title + ' ' + p.positions).toLowerCase().includes(q)) continue;
        out.push({
          id: p.id, eventId: e.id, eventTitle: e.title, school: e.school, kind: e.kind, startAt: e.startAt,
          company: p.company, title: p.title, positions: p.positions,
          applyMode: p.applyMode, applyUrl: p.applyUrl, sourceUrl: p.sourceUrl || e.sourceUrl,
          sourceId: p.sourceId
        });
      }
    }
    return {
      status: out.length ? 'readable' : 'empty',
      notice: '项目来自高校就业网/公众号；平台仅用于研究岗位要求和薪资，不在这里登记岗位或投递。',
      count: out.length,
      projects: out.slice(0, Math.min(100, Number(args.limit) || 50))
    };
  } finally { store.close(); }
}

export async function project(args, ctx) {
  const dir = ctxDir(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库。'};
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const p = store.getProject(String(args.id || ''));
    if (!p) return {status: 'not_found', message: '没有这个招聘项目'};
    const e = store.getEvent(p.eventId);
    return {status: 'readable', project: p, event: e};
  } finally { store.close(); }
}

export async function sourceStates(args, ctx) {
  const dir = ctxDir(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库。', sources: []};
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    store.syncSources(SOURCES);
    const states = store.sourceStates();
    return {
      status: 'readable',
      notice: 'ok 只在列表解析成功时使用；项目阶段失败会标 list_only 或给出原因。',
      count: states.length,
      sources: states.map(s => ({...sourceHealth(SOURCES.find(x => x.id === s.id) || {id: s.id, name: s.name, enabled: !!s.enabled, mode: s.mode, category: s.category}), lastStatus: s.last_status, lastCount: s.last_count, lastError: s.last_error, lastRun: s.last_run}))
    };
  } finally { store.close(); }
}

// 读取本机招聘库：按日历列出活动与一对多的招聘项目；行程冲突/通勤规划已暂停。
export async function events(args, ctx) {
  const dir = ctx.config?.recruitDir;
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库，请让用户先在“招聘日历”里采集。', events: []};
  const days = Math.min(90, Math.max(1, Number(args.days) || 30));
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
    const to = new Date(Date.now() + days * 86400000).toISOString();
    const list = store.listEvents({from, to, limit: 300, school: args.school || undefined, kind: args.kind || undefined, withProjects: true});
    const groups = new Map();
    for (const e of list) {
      const date = e.startAt.slice(0, 10);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(e);
    }
    const lines = [`# 未来 ${days} 天线下招聘活动`, '', `> 共 ${list.length} 场活动，${list.reduce((n, e) => n + (e.projects?.length || 0), 0)} 个招聘项目。通勤与冲突规划已暂停。`, ''];
    for (const [date, items] of groups) {
      const weekday = '日一二三四五六'[new Date(date + 'T00:00:00+08:00').getDay()];
      lines.push(`## ${date}（周${weekday}）`, '');
      for (const e of items) {
        const time = e.startAt.slice(11, 16);
        lines.push(`- **${time} ${e.title}**（${e.school || '未知学校'} · ${e.kind || '活动'}）`);
        if (e.venue) lines.push(`  - 地点：${e.venue}`);
        if (e.company) lines.push(`  - 单位：${e.company}`);
        if (e.applyMode) lines.push(`  - 投递：${e.applyMode}`);
        for (const p of e.projects || []) {
          lines.push(`  - 项目：${[p.company, p.title].filter(Boolean).join(' · ')}${p.applyMode ? '（' + p.applyMode + '）' : ''}`);
        }
      }
      lines.push('');
    }
    return {
      status: list.length ? 'readable' : 'empty',
      notice: '数据来自本机已采集的高校就业网；未复核条目请点来源链接确认。已暂停冲突/通勤规划。',
      count: list.length,
      stats: {days: groups.size, events: list.length, projects: list.reduce((n, e) => n + (e.projects?.length || 0), 0)},
      markdown: list.length ? lines.join('\n') : '',
      events: list.slice(0, 60).map(e => ({
        id: e.id, school: e.school, title: e.title, company: e.company, kind: e.kind,
        startAt: e.startAt, endAt: e.endAt, venue: e.venue, sourceUrl: e.sourceUrl, verified: e.verified,
        projects: (e.projects || []).map(p => ({company: p.company, title: p.title, applyMode: p.applyMode, applyUrl: p.applyUrl}))
      }))
    };
  } finally { store.close(); }
}
