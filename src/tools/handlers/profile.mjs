// 长期画像写入（敏感）：先挂起确认，用户接受后由确认接口按原参数重放。
// 一次调用 = 一个批次；业务行、write_audit、idempotency 同库同事务；未确认不落库。
import {createWriteGateway} from '../../writes/gateway.mjs';
import {writeFailure} from '../../writes/errors.mjs';
import {
  PROFILE_FACT_LIMITS, listProfileFacts, normalizeProfileFacts, openProfileDb, profileDbPath,
  validateProfileFacts, writeProfileFacts
} from '../../profile/store.mjs';

function dirOf(ctx) {
  return ctx.config?.profileDir || ctx.config?.dataDir || ctx.config?.recruitDir || '';
}

export async function profileWrite(args, ctx = {}) {
  const dir = dirOf(ctx);
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联用户数据目录，无法写入长期画像。', recovery: '请先登录网页端。'};
  const userId = String(ctx.config?.userId || ctx.userId || '').trim();
  if (!userId) return {status: 'error', code: 'UNAUTHORIZED', message: '长期画像写入需要登录用户身份。', recovery: '请先在网页端登录后再让智能体写入。'};
  const invalid = validateProfileFacts(args.facts);
  if (invalid) return {status: 'error', code: 'INVALID_ARGUMENTS', message: invalid, recovery: '按工具参数说明修正画像条目后重试。'};
  const facts = normalizeProfileFacts(args.facts);
  const db = openProfileDb(profileDbPath(dir));
  try {
    const existing = new Set(listProfileFacts(db, userId).map(fact => fact.key));
    const additions = facts.filter(fact => !existing.has(fact.key)).length;
    if (existing.size + additions > PROFILE_FACT_LIMITS.facts) {
      return {
        status: 'error', code: 'PROFILE_LIMIT',
        message: '长期画像最多保存 ' + PROFILE_FACT_LIMITS.facts + ' 条，本次写入会超出上限。',
        recovery: '先删除旧条目或减少本次写入。'
      };
    }
    const gateway = createWriteGateway({
      db, domain: 'profile', userId,
      actorType: ctx.config?.actorType || 'model',
      actorRef: ctx.config?.actorRef || '',
      taskId: ctx.config?.taskId || ctx.taskId || ''
    });
    const outcome = await gateway.write({
      tool: 'career_profile_write',
      sensitivity: 'sensitive',
      payload: {facts},
      idempotencyKey: args.idempotencyKey,
      confirmId: args.confirmId || '',
      confirmationKey: args.confirmationKey || '',
      approveConfirmation: ctx.confirmed === true,
      preview: {facts},
      entity: 'profile_facts',
      action: 'create',
      execute: () => writeProfileFacts({db, userId, facts})
    });
    if (outcome.status === 'confirm_required') {
      return {
        status: 'confirm_required',
        code: 'NEEDS_CONFIRMATION',
        message: '长期画像属于敏感写入：这次内容还没有落库，需要你在任务卡确认后才会保存。',
        confirmId: outcome.confirmId,
        taskId: outcome.taskId || '',
        preview: outcome.preview,
        expiresAt: outcome.expiresAt,
        recovery: '在任务卡的待确认区点「接受」后重试。'
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
    if (!outcome.duplicate) result.writeEvent = {batchId: outcome.batchId, counts};
    return result;
  } catch (error) {
    return writeFailure(error);
  } finally {
    db.close();
  }
}

