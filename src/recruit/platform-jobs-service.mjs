// 平台岗位服务（#51）：把只读读到的岗位整理成项目行；写入前必须经过用户确认，从不代投递。
import {join} from 'node:path';
import {RecruitStore, savePlatformJobRows} from './store.mjs';
import {normalizePlatformJobs} from './platform-jobs.mjs';
import {extractPlatformJobs} from '../platform/jobs.mjs';
import {createWriteGateway} from '../writes/gateway.mjs';
import {writeFailure} from '../writes/errors.mjs';
import {isPlatformId, PLATFORM_IDS, PLATFORM_SITES} from '../platform/sites.mjs';

const LIMIT = 50;

function platformOptions() {
  return PLATFORM_IDS.map(id => ({id, name: PLATFORM_SITES[id].name}));
}

function withStore(dir, fn) {
  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try { return fn(store); } finally { store.close(); }
}

// 平台岗位清单：q（单位/岗位/要求）、city、platform 三个筛选条件可组合。
export function listPlatformJobs({dir, q = '', city = '', platform = '', limit = 50} = {}) {
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库。', jobs: [], count: 0, platforms: platformOptions()};
  const jobs = withStore(dir, store => store.listPlatformJobs({q, city, platform, limit}));
  return {
    status: jobs.length ? 'readable' : 'empty',
    notice: '平台岗位来自本人登录后的只读浏览；来源链接、抓取时间与置信度随行保存，未代投递。',
    count: jobs.length,
    jobs,
    platforms: platformOptions()
  };
}

/**
 * 把当前页面快照里的岗位写入 event_projects：
 * 1) 先按浏览器实际读到的内容抽取岗位（不信任模型自报的数据）；
 * 2) 走写网关的敏感确认：用户不在任务卡接受，就不落库；
 * 3) 确认接受时由服务端按保存的 payload 重放，重试同一幂等键不会重复写。
 */
export async function savePlatformJobs({dir, userId, taskId = '', actorType = 'model', actorRef = '', platform, city = '', query = '', sourceUrls = [], snapshot, idempotencyKey, confirmId = '', approveConfirmation = false} = {}) {
  if (!dir) return {status: 'unavailable', message: '当前任务没有关联招聘数据库，无法保存平台岗位。'};
  if (!userId) return {status: 'error', code: 'UNAUTHORIZED', message: '平台岗位入库需要登录用户身份。', recovery: '请先在网页端登录后再保存。'};
  if (!isPlatformId(platform)) return {status: 'error', code: 'INVALID_ARGUMENTS', message: '不支持的网站。', recovery: '先从这 7 个登录型网站里选择一个再读取。'};
  if (!snapshot || (!Array.isArray(snapshot.links) && !snapshot.url)) {
    return {status: 'needs_read', code: 'PLATFORM_NOT_READ', message: '请先读取该网站的岗位页面，再把读到的岗位入库。', recovery: '先调用 career_platform_search 或 career_platform_read。'};
  }

  const fetchedAt = snapshot.at || new Date().toISOString();
  let jobs = extractPlatformJobs({
    platform,
    url: String(snapshot.url || ''),
    pageTitle: String(snapshot.title || ''),
    text: String(snapshot.text || ''),
    links: Array.isArray(snapshot.links) ? snapshot.links : [],
    city: String(city || ''),
    capturedAt: fetchedAt
  });
  const only = new Set((Array.isArray(sourceUrls) ? sourceUrls : []).map(item => String(item)));
  if (only.size) jobs = jobs.filter(job => only.has(job.sourceUrl));
  jobs = jobs.slice(0, LIMIT);
  if (!jobs.length) {
    return {status: 'empty', message: '当前页面没有识别到可入库的岗位；请打开岗位详情或搜索结果后重试。', recovery: '换一个岗位页面再读取，不要手工编造岗位。'};
  }

  const normalized = normalizePlatformJobs({platform, city, query, fetchedAt, jobs});
  if (normalized.error) return {status: 'error', code: 'INVALID_ARGUMENTS', message: normalized.error, recovery: '换一个岗位页面或缩小入库范围后重试。'};
  const payload = {platform: normalized.platform, city: normalized.city, query: normalized.query, fetchedAt: normalized.fetchedAt, jobs: normalized.jobs};
  const preview = {
    platform,
    platformName: PLATFORM_SITES[platform]?.name || platform,
    city: payload.city,
    fetchedAt: payload.fetchedAt,
    total: payload.jobs.length,
    jobs: payload.jobs.slice(0, 20).map(job => ({
      company: job.company, title: job.title, city: job.city,
      positions: job.positions, sourceUrl: job.sourceUrl, confidence: job.confidence
    }))
  };

  const store = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId, actorType, actorRef, taskId});
    const outcome = await gateway.write({
      tool: 'career_platform_jobs_save',
      sensitivity: 'sensitive',
      payload,
      idempotencyKey,
      confirmId,
      approveConfirmation,
      preview,
      sourceRef: {platform, url: String(snapshot.url || '')},
      entity: 'event_projects',
      action: 'create',
      execute: ({db}) => savePlatformJobRows({db, payload})
    });
    if (outcome.status === 'confirm_required') {
      return {
        status: 'confirm_required',
        code: 'NEEDS_CONFIRMATION',
        message: '这批平台岗位需要你在任务卡确认后才会写入本机项目表。',
        confirmId: outcome.confirmId,
        preview: outcome.preview,
        expiresAt: outcome.expiresAt,
        recovery: '在任务卡点「接受」后由服务端按原参数写入；不接受则不落库。'
      };
    }
    return {
      status: 'ok',
      batchId: outcome.batchId || '',
      duplicate: !!outcome.duplicate,
      created: Number(outcome.counts?.created) || 0,
      updated: Number(outcome.counts?.updated) || 0,
      skipped: normalized.skipped,
      total: payload.jobs.length,
      platform,
      result: outcome.result || null
    };
  } catch (error) {
    return writeFailure(error);
  } finally {
    store.close();
  }
}
