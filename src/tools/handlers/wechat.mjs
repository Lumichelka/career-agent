// 公众号文章只读查询：按账号/学校/关键词读已导入或同步的文章、分析草稿与关联活动/项目。
// 不抓取、不写库、不投递；关联数据只从本机招聘库读取。
import {existsSync} from 'node:fs';
import {join} from 'node:path';

function dataDir(ctx) {
  return ctx.config?.dataDir || ctx.config?.recruitDir || '';
}

export async function articles(args, ctx) {
  const dir = dataDir(ctx);
  if (!dir) {
    return {
      status: 'unavailable',
      message: '当前任务没有关联公众号文章库，请先在“数据与日历”的公众号来源里导入或同步文章。',
      articles: []
    };
  }
  if (!existsSync(join(dir, 'wechat.db'))) {
    return {
      status: 'empty',
      notice: '本机还没有公众号文章库；先在“数据与日历”的公众号来源里导入或同步文章。',
      count: 0,
      articles: []
    };
  }
  const {WeChatStore} = await import('../../wechat/store.mjs');
  const store = WeChatStore.open(join(dir, 'wechat.db'), {readOnly: true});
  let recruit = null;
  try {
    const {total, rows} = store.searchArticles({
      account: args.account, school: args.school, q: args.q,
      hasRecruitment: args.hasRecruitment, limit: args.limit
    });
    if (!rows.length) {
      return {
        status: 'empty',
        notice: '本机没有符合条件的公众号文章；可先在“数据与日历”导入或同步。',
        count: 0,
        articles: []
      };
    }
    // 有关联活动时才打开招聘库；打开不存在的库会新建空库，只读工具不能这么做。
    if (rows.some(row => row.eventId) && existsSync(join(dir, 'recruit.db'))) {
      const {RecruitStore} = await import('../../recruit/store.mjs');
      recruit = RecruitStore.open(join(dir, 'recruit.db'), {readOnly: true});
    }
    const articles = rows.map(row => {
      let analysis = null;
      try { analysis = JSON.parse(row.extractedJson || 'null'); } catch { analysis = null; }
      const event = recruit && row.eventId ? recruit.getEvent(row.eventId) : null;
      const eventProjects = event ? recruit.listProjects(event.id).filter(p => p.status !== 'removed') : [];
      return {
        id: row.id,
        account: {id: row.accountId, name: row.accountName || '未归属', school: row.accountSchool || ''},
        title: row.title,
        url: row.url,
        publishedAt: row.publishedAt || '',
        hasRecruitment: row.hasRecruitment || '',
        analyzed: Boolean(row.analyzedAt),
        summary: row.summary || '',
        analysis: analysis ? {
          hasRecruitment: analysis.hasRecruitment || '',
          summary: analysis.summary || '',
          warnings: Array.isArray(analysis.warnings) ? analysis.warnings : []
        } : null,
        draft: analysis?.draft && typeof analysis.draft === 'object' ? {
          title: analysis.draft.title || '', company: analysis.draft.company || '',
          kind: analysis.draft.kind || '', city: analysis.draft.city || '',
          venue: analysis.draft.venue || '', startAt: analysis.draft.startAt || '',
          endAt: analysis.draft.endAt || '', applyMode: analysis.draft.applyMode || '',
          sourceUrl: analysis.draft.sourceUrl || '', notes: analysis.draft.notes || ''
        } : null,
        draftProjects: Array.isArray(analysis?.projects) ? analysis.projects.slice(0, 20).map(project => ({
          company: project.company || '', title: project.title || '', positions: project.positions || '',
          applyMode: project.applyMode || '', applyUrl: project.applyUrl || '',
          sourceUrl: project.sourceUrl || '', notes: project.notes || ''
        })) : [],
        projectCount: Number(row.projectCount) || 0,
        event: event ? {
          id: event.id, title: event.title, school: event.school, kind: event.kind,
          startAt: event.startAt, venue: event.venue, sourceUrl: event.sourceUrl
        } : null,
        eventProjects: eventProjects.slice(0, 20).map(project => ({
          id: project.id, company: project.company, title: project.title, positions: project.positions,
          requirements: project.requirements || '', notes: project.notes || '',
          applyMode: project.applyMode, applyUrl: project.applyUrl, sourceUrl: project.sourceUrl
        })),
        source: {
          id: row.accountId ? 'wechat:' + row.accountId : '',
          name: row.accountName || '未归属',
          school: row.accountSchool || '',
          type: 'wechat',
          articleUrl: row.url
        }
      };
    });
    return {
      status: 'readable',
      notice: '只读：文章与草稿来自本机已导入/同步记录，未重新抓取；关联活动/项目来自本机招聘库，草稿与未核实条目需要人工核对后才可写入。',
      count: total,
      returned: articles.length,
      articles
    };
  } finally {
    store.close();
    recruit?.close();
  }
}
