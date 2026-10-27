import {join} from 'node:path';
import {SOURCES, REMOVED_SOURCES, sourceHealth} from '../../recruit/sources/index.mjs';
import {createWriteGateway} from '../../writes/gateway.mjs';
import {writeFailure} from '../../writes/errors.mjs';
import {bulkWriteRows, normalizeSource, validateBulkPayload} from '../../recruit/bulk.mjs';
import {readFeed} from '../../recruit/feed.mjs';

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
      notice: '项目来自高校就业网/公众号；平台岗位由用户确认后入库，用 career_platform_jobs 查询，不代投递。',
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

// career_feed：/chat 与入站 MCP 共用同一条读取路径；身份只来自 ctx（入站 client 也落到所属账号目录）。
// 只读：打开业务库读 events/projects/companies 与 write_audit，不写业务行、不产生审计。
export async function feed(args, ctx) {
  const dir = ctxDir(ctx);
  const since = args.since;
  if (!dir) {
    return {
      status: 'unavailable',
      message: '当前任务没有关联招聘数据库。',
      entries: [],
      nextCursor: Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0,
      hasMore: false
    };
  }
  const dataDir = ctx.config?.dataDir || dir;
  const userId = String(ctx.config?.userId || ctx.userId || '').trim();
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    return readFeed({
      db: store.db,
      companyDir: dir,
      dataDir,
      userId,
      since,
      types: args.types,
      sourceId: args.sourceId || '',
      limit: args.limit,
      offset: args.offset,
      includeRawText: args.includeRawText === true
    });
  } catch (error) {
    if (error?.code === 'INVALID_ARGUMENTS') {
      return {status: 'error', code: 'INVALID_ARGUMENTS', message: error.message, recovery: '按工具参数说明修正后重试。'};
    }
    throw error;
  } finally {
    store.close();
  }
}

export async function sourceStates(args, ctx) {
  const dir = ctxDir(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库。', sources: []};
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    store.syncSources(SOURCES, REMOVED_SOURCES);
    const states = store.sourceStates();
    return {
      status: 'readable',
      notice: 'ok 只在列表解析成功时使用；项目阶段失败会标 list_only 或给出原因。',
      count: states.length,
      sources: states.map(s => ({...sourceHealth(SOURCES.find(x => x.id === s.id) || {id: s.id, name: s.name, enabled: !!s.enabled, mode: s.mode, category: s.category}), orphaned: !!s.orphaned, lastStatus: s.last_status, lastCount: s.last_count, lastError: s.last_error, lastRun: s.last_run}))
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

// 自动写入：一次调用 = 一个批次；业务行、write_audit、idempotency 同库同事务。
// 只写 events / event_projects；source_id=manual 表示手动/浏览器读取；不写公司档案。
export async function bulkWrite(args, ctx) {
  const dir = ctxDir(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库，无法自动写入。', recovery: '请先在本机招聘库准备好数据目录。'};
  const userId = String(ctx.config?.userId || ctx.userId || '').trim();
  if (!userId) {
    return {status: 'error', code: 'UNAUTHORIZED', message: '自动写入需要登录用户身份。', recovery: '请先在网页端登录后再让智能体写入。'};
  }
  const source = normalizeSource(args.source);
  const invalid = validateBulkPayload(args.events, args.projects, args.source);
  if (invalid) {
    return {status: 'error', code: 'INVALID_ARGUMENTS', message: invalid, recovery: '按工具参数说明修正后重试。'};
  }
  const {RecruitStore} = await import('../../recruit/store.mjs');
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    // 业务写入必须复用这条连接；网关在同一事务里写业务行、审计与幂等。
    const gateway = createWriteGateway({
      db: store.db,
      domain: 'recruit',
      userId,
      actorType: ctx.config?.actorType || 'model',
      actorRef: ctx.config?.actorRef || '',
      taskId: ctx.config?.taskId || ctx.taskId || ''
    });
    const projects = args.projects || [];
    const outcome = await gateway.write({
      tool: 'career_recruit_bulk_write',
      sensitivity: 'auto',
      payload: {events: args.events, projects, source},
      idempotencyKey: args.idempotencyKey,
      confirmId: args.confirmId || '',
      // 确认接口（#30）用新幂等键执行时，用 confirmationKey 指向发起确认时的原键。
      confirmationKey: args.confirmationKey || '',
      approveConfirmation: ctx.confirmed === true,
      entity: 'events',
      action: 'create',
      sourceRef: source,
      execute: () => bulkWriteRows({store, events: args.events, projects, source})
    });
    if (outcome.status === 'confirm_required') {
      return {
        status: 'confirm_required',
        code: 'NEEDS_CONFIRMATION',
        message: '这次写入需要你确认后才会落库。',
        confirmId: outcome.confirmId,
        preview: outcome.preview,
        expiresAt: outcome.expiresAt,
        recovery: '在任务卡确认后重试。'
      };
    }
    const counts = {
      rows: Number(outcome.counts?.rows) || 0,
      created: Number(outcome.counts?.created) || 0,
      updated: Number(outcome.counts?.updated) || 0,
      deleted: Number(outcome.counts?.deleted) || 0,
      skipped: Number(outcome.counts?.skipped) || 0
    };
    const result = {
      status: 'ok',
      batchId: outcome.batchId,
      duplicate: !!outcome.duplicate,
      confirmed: !!outcome.confirmed,
      counts,
      result: outcome.result || null
    };
    // 只有真正写入（不是幂等重放）才发 writes 事件，任务卡不会把重放算成新写入。
    if (!outcome.duplicate) result.writeEvent = {batchId: outcome.batchId, counts};
    return result;
  } catch (error) {
    return writeFailure(error);
  } finally {
    store.close();
  }
}
