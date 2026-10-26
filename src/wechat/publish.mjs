// 文章 → 活动/项目：把已分析的招聘推文写成带来源的 events/event_projects。
// 只有同时识别到开始时间和至少一个参会单位才自动落库，避免把月历/邀请函写成空活动。
// 自动写入走写网关：业务行与 write_audit 同事务，可在审计里撤销；不再提供 force 旁路。
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {RecruitStore} from '../recruit/store.mjs';
import {WeChatStore} from './store.mjs';
import {analyzeArticle} from './analyze.mjs';
import {createWriteGateway} from '../writes/gateway.mjs';

function sha1(value) { return createHash('sha1').update(String(value)).digest('hex'); }

export function isValidStartAt(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:：](\d{2})/);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function publishedIso(value) {
  const text = String(value || '').trim();
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  return text.slice(0, 40);
}

function draftOf(article, analysis) {
  return analysis?.draft || {};
}

function projectRows(projects, article) {
  return (projects || []).map(project => {
    const company = String(project.company || '').trim().slice(0, 120);
    const title = String(project.title || '').trim().slice(0, 200);
    return {
      company, title,
      positions: String(project.positions || '').trim().slice(0, 2000),
      requirements: String(project.requirements || '').trim().slice(0, 4000),
      applyMode: String(project.applyMode || '').trim().slice(0, 60),
      applyUrl: String(project.applyUrl || '').trim().slice(0, 500),
      sourceUrl: article.url,
      notes: '来自公众号文章：' + article.title,
      sourceKey: sha1([company, title, article.url].join('|')).slice(0, 32),
      confidence: 0.6,
      rawText: String(project.notes || '').slice(0, 4000)
    };
  }).filter(project => project.company || project.title);
}

/**
 * 发布一篇文章到招聘库。返回 {ok, event, projects, action, batchId} 或 {ok:false, reason}。
 * store/recruitStore 可注入，便于 API 与测试共用同一个连接；不注入时按 dir 打开并负责关闭。
 * audit = {userId, actorType, actorRef, taskId, idempotencyKey, tool}：提供 userId 时自动写入走写网关并写审计。
 * 没有 force：至少 1 个单位 + 合法开始时间 + 非“未发现招聘”才允许写入，人工确认也不能绕过事实门禁。
 */
export async function publishArticle({dir, articleId, store, recruitStore, analyze = analyzeArticle, audit = null} = {}) {
  const ws = store || (dir ? WeChatStore.open(join(dir, 'wechat.db')) : null);
  const rs = recruitStore || (dir ? RecruitStore.open(join(dir, 'recruit.db')) : null);
  if (!ws || !rs) throw new Error('publishArticle 需要 dir 或 store/recruitStore');
  try {
    const article = ws.getArticle(articleId);
    if (!article) return {ok: false, reason: 'not_found'};
    let analysis = null;
    try { analysis = JSON.parse(article.extractedJson || 'null'); } catch { analysis = null; }
    if (!analysis || !analysis.draft) {
      analysis = analyze({title: article.title, text: article.content || article.summary || '', url: article.url});
      ws.saveAnalysis(article.id, analysis);
    }
    const projects = Array.isArray(analysis.projects) ? analysis.projects : [];
    if (!projects.length) return {ok: false, reason: 'no_projects', article, analysis};
    const draft = draftOf(article, analysis);
    const startAt = String(draft.startAt || '');
    if (!isValidStartAt(startAt)) return {ok: false, reason: 'invalid_start_at', article, analysis};
    if (article.hasRecruitment === 'no') return {ok: false, reason: 'not_recruitment', article, analysis};

    const account = article.accountId ? ws.getAccount(article.accountId) : null;
    const sourceId = 'wechat:' + (article.accountId || 'unknown');
    const now = new Date().toISOString();
    const title = String(draft.title || article.title).trim().slice(0, 200);
    const eventId = 'wx-' + sha1(sourceId + '|' + article.url).slice(0, 24);
    const existingById = rs.getEvent(eventId);
    const existingBySource = rs.db.prepare('SELECT id FROM events WHERE source_id=? AND source_url=? LIMIT 1').get(sourceId, article.url);
    const existingByTitle = rs.db.prepare("SELECT id FROM events WHERE title=? AND start_at=? AND status!='cancelled' ORDER BY last_seen_at DESC LIMIT 1").get(title, startAt);
    const previous = existingById || (existingBySource ? rs.getEvent(existingBySource.id) : null) || (existingByTitle ? rs.getEvent(existingByTitle.id) : null);
    const before = previous ? rs.getEvent(previous.id) : null;

    const warnings = (analysis.warnings || []).join('；');
    const record = {
      id: previous?.id || eventId,
      sourceId,
      school: account?.school || draft.school || '公众号',
      city: draft.city || '',
      kind: draft.kind || '招聘信息',
      title,
      company: draft.company || '',
      startAt,
      endAt: draft.endAt || '',
      venue: draft.venue || '',
      address: draft.address || '',
      industry: draft.industry || '',
      companySize: draft.companySize || '',
      positions: draft.positions || '',
      requirements: draft.requirements || '',
      applyMode: draft.applyMode || '',
      applyUrl: draft.applyUrl || '',
      sourceUrl: article.url,
      publishedAt: publishedIso(article.publishedAt),
      fetchedAt: now,
      confidence: 0.6,
      rawText: String(article.content || '').slice(0, 20000),
      notes: ['公众号自动抽取（' + (account?.name || '未归属') + '）', '待核对', warnings].filter(Boolean).join('；'),
      status: 'active'
    };
    const rows = projectRows(projects, article);

    // 业务写入 + 审计同一事务：事件 1 行 + 项目增改/软删除若干行。
    const write = () => {
      const action = rs.upsertEvent(record);
      const savedEvent = rs.getEvent(record.id);
      const sync = rs.syncProjects(savedEvent.id, sourceId, rows);
      const after = rs.getEvent(savedEvent.id);
      const changes = [{
        action: before ? 'update' : 'create', entity: 'events', entityId: savedEvent.id,
        oldValues: before, newValues: after, note: '公众号自动抽取并写入（可在审计中撤销）'
      }, ...(sync.changes || [])];
      return {
        changes,
        result: {action, eventId: savedEvent.id, sync: {created: sync.created, updated: sync.updated, removed: sync.removed, total: sync.total}}
      };
    };

    let outcome;
    if (audit?.userId) {
      const gateway = createWriteGateway({
        db: rs.db, domain: 'recruit', userId: audit.userId,
        actorType: audit.actorType || 'model', actorRef: audit.actorRef || '', taskId: audit.taskId || ''
      });
      const payload = {articleId: article.id, sourceId, title, startAt, projects: rows};
      const idempotencyKey = String(audit.idempotencyKey || ('wechat-publish:' + sha1([article.id, title, startAt, JSON.stringify(rows)].join('|')).slice(0, 24))).slice(0, 200);
      // 公众号操作员可以把证据文件挂到审计来源（artifact:<file>），feed 的 evidence_ref/evidence_available 据此解析。
      const sourceRef = Object.hasOwn(audit, 'sourceRef') ? audit.sourceRef : {article: article.url, articleId: article.id};
      outcome = await gateway.write({
        tool: audit.tool || 'career_wechat_publish',
        payload,
        idempotencyKey,
        sourceRef,
        execute: write
      });
    } else {
      outcome = {status: 'applied', duplicate: false, ...write()};
    }

    const savedEvent = rs.getEvent(outcome.result?.eventId || record.id);
    if (!savedEvent) return {ok: false, reason: 'not_found'};
    ws.linkEvent(article.id, savedEvent.id);
    return {
      ok: true,
      duplicate: !!outcome.duplicate,
      batchId: outcome.batchId || '',
      action: outcome.result?.action || (before ? 'updated' : 'created'),
      event: savedEvent,
      projects: rs.listProjects(savedEvent.id),
      sync: outcome.result?.sync || {created: 0, updated: 0, removed: 0, total: rows.length},
      analysis
    };
  } finally {
    if (!store) ws?.close();
    if (!recruitStore) rs?.close();
  }
}
