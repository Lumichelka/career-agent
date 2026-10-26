// 平台岗位写入前的归一化与校验（#51）：只接受本平台白名单内的来源链接；
// 不补造单位/城市/薪资，不写投递方式；同一来源键重复出现时只保留一条。
import {createHash} from 'node:crypto';
import {isPlatformId, siteUrlAllowed} from '../platform/sites.mjs';

const JOB_LIMIT = 50;
const JOB_FIELDS = {company: 120, title: 200, positions: 2000, requirements: 4000, city: 20, sourceUrl: 500, sourceKey: 200, notes: 2000};

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return String(raw || ''); }
}

function normalizeAt(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function confidenceOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.6;
  return Math.round(Math.min(0.9, Math.max(0.3, n)) * 1000) / 1000;
}

export function validatePlatformJobsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '平台岗位参数格式不正确。';
  if (!isPlatformId(payload.platform)) return '不支持的网站。';
  if (!Array.isArray(payload.jobs) || payload.jobs.length === 0) return '没有可入库的平台岗位。';
  if (payload.jobs.length > JOB_LIMIT) return '一次最多写入 ' + JOB_LIMIT + ' 个平台岗位。';
  for (let index = 0; index < payload.jobs.length; index++) {
    const job = payload.jobs[index];
    if (!job || typeof job !== 'object' || Array.isArray(job)) return '第 ' + (index + 1) + ' 个岗位格式不正确。';
    const title = text(job.title, JOB_FIELDS.title);
    const company = text(job.company, JOB_FIELDS.company);
    if (!title && !company) return '第 ' + (index + 1) + ' 个岗位需要 title 或 company。';
    if (!siteUrlAllowed(payload.platform, text(job.sourceUrl, JOB_FIELDS.sourceUrl))) {
      return '第 ' + (index + 1) + ' 个岗位的来源链接不属于该平台。';
    }
  }
  return null;
}

/**
 * 把页面抽取出的岗位整理成可落库字段。返回 {jobs, skipped, ...} 或 {error}。
 * 幂等：已带 sourceKey 的原样保留；没有时用平台 + 规范化链接 + 单位 + 岗位算稳定键。
 */
export function normalizePlatformJobs(payload = {}) {
  if (!isPlatformId(payload.platform)) return {error: '不支持的网站。'};
  if (!Array.isArray(payload.jobs) || payload.jobs.length === 0) return {error: '没有可入库的平台岗位。'};
  if (payload.jobs.length > JOB_LIMIT) return {error: '一次最多写入 ' + JOB_LIMIT + ' 个平台岗位。'};
  const platform = payload.platform;
  const defaultCity = text(payload.city, JOB_FIELDS.city);
  const query = text(payload.query, 120);
  const fetchedAt = normalizeAt(payload.fetchedAt);
  const jobs = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of payload.jobs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; continue; }
    const sourceUrl = text(raw.sourceUrl, JOB_FIELDS.sourceUrl);
    if (!siteUrlAllowed(platform, sourceUrl)) { skipped++; continue; }
    const company = text(raw.company, JOB_FIELDS.company);
    const title = text(raw.title, JOB_FIELDS.title);
    if (!company && !title) { skipped++; continue; }
    const sourceKey = text(raw.sourceKey, JOB_FIELDS.sourceKey)
      || createHash('sha1').update([platform, canonicalUrl(sourceUrl), company, title].join('|')).digest('hex').slice(0, 32);
    if (seen.has(sourceKey)) { skipped++; continue; }
    seen.add(sourceKey);
    jobs.push({
      company,
      title,
      positions: text(raw.positions, JOB_FIELDS.positions),
      requirements: text(raw.requirements, JOB_FIELDS.requirements),
      city: text(raw.city, JOB_FIELDS.city) || defaultCity,
      sourceUrl,
      sourceKey,
      confidence: confidenceOf(raw.confidence),
      notes: text(raw.notes, JOB_FIELDS.notes),
      rawText: String(raw.rawText ?? '').slice(0, 4000),
      fetchedAt: normalizeAt(raw.fetchedAt || fetchedAt)
    });
  }
  if (!jobs.length) return {error: '没有通过校验的平台岗位（来源链接必须属于该平台）。'};
  return {platform, city: defaultCity, query, fetchedAt, jobs, skipped};
}
