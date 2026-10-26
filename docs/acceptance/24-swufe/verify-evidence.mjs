// 验收证据包校验器（docs 工具，不参与应用运行）。
// 用法：
//   node docs/acceptance/24-swufe/verify-evidence.mjs <manifest.json>
//   node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db <recruit.db>
// 校验内容：已签署「验收通过」+ 日期、证据文件存在且 sha256 一致、抽取/复核/审计不含联系方式、
// DB 快照内容哈希与行数一致、成功标准计数达标。模板（pending / 占位符）会被明确判为不通过，
// 避免把空模板或确定性测试输出当成 live 验收证据。
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const PLACEHOLDER = /<[^>]*(?:待填写|填写|YYYY|sha256|路径|id|owner)[^>]*>/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTACT_KEY = /(contact|phone|mobile|telephone|tel|email|mail|wechat|weixin|idcard|identity|联系人|联系方式|手机|电话|邮箱|微信|身份证|证件)/i;
const CONTACT_VALUE = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?<!\d)\d{17}[\dXx](?!\d)/;

// 与 tests/acceptance-swufe.test.mjs、docs/plan/24 §7 同一口径：events + event_projects 整行内容哈希。
export function contentHashOf(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    const events = db.prepare('SELECT * FROM events ORDER BY id').all();
    const projects = db.prepare('SELECT * FROM event_projects ORDER BY id').all();
    return {
      events: events.length,
      projects: projects.length,
      hash: createHash('sha256').update(JSON.stringify({events, projects})).digest('hex')
    };
  } finally {
    db.close();
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function resolveFile(baseDir, file) {
  return isAbsolute(String(file || '')) ? String(file) : resolve(baseDir, String(file || ''));
}

function walk(value, visit, path = '') {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, path + '[' + index + ']'));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, visit, path ? path + '.' + key : key);
  }
}

function contactFindings(value) {
  const findings = [];
  walk(value, (item, path) => {
    if (typeof item === 'string' && CONTACT_VALUE.test(item)) findings.push('值里出现联系方式：' + path);
    if (item && typeof item === 'object') {
      for (const key of Object.keys(item)) if (CONTACT_KEY.test(key)) findings.push('字段名含联系方式：' + (path ? path + '.' : '') + key);
    }
  });
  return findings;
}

function collectPlaceholders(manifest) {
  const hits = [];
  walk(manifest, (item, path) => { if (typeof item === 'string' && PLACEHOLDER.test(item)) hits.push(path); });
  return hits;
}

function checkNumber(errors, checks, key, test, message) {
  const value = checks?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push('checks.' + key + ' 必须是数字'); return; }
  if (!test(value)) errors.push(message);
}

// 检查单个证据条目：路径存在、sha256 格式与内容一致；JSON 证据再做解析与联系方式扫描。
function checkEvidence(errors, baseDir, key, entry, {json = false} = {}) {
  if (!entry || typeof entry !== 'object') { errors.push('缺少证据条目：' + key); return null; }
  if (!entry.path || typeof entry.path !== 'string') { errors.push(key + '.path 不能为空'); return null; }
  const file = resolveFile(baseDir, entry.path);
  if (!existsSync(file)) { errors.push(key + ' 指向的文件不存在：' + file); return null; }
  if (!SHA256.test(String(entry.sha256 || ''))) { errors.push(key + '.sha256 必须是 64 位小写 hex'); return null; }
  const actual = sha256File(file);
  if (actual !== entry.sha256) { errors.push(key + ' 的 sha256 与实际文件不一致（实际 ' + actual + '）'); return null; }
  if (json) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { errors.push(key + ' 不是合法 JSON：' + String(error.message || error)); return null; }
    for (const finding of contactFindings(parsed)) errors.push(key + ' 泄露联系方式：' + finding);
    return parsed;
  }
  return {file};
}

export async function verifyManifest(manifest, {baseDir = process.cwd()} = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {ok: false, errors: ['manifest 不是 JSON 对象']};
  }
  if (manifest.status !== 'passed') {
    errors.push('status 仍是 "' + manifest.status + '"：模板或未完成验收，不能作为 live 证据');
  }
  const placeholders = collectPlaceholders(manifest);
  if (placeholders.length) errors.push('仍有未填写的占位符：' + placeholders.slice(0, 8).join('、'));

  const signature = manifest.signature;
  if (!signature || typeof signature !== 'object') errors.push('缺少 signature 签字区');
  else {
    if (!String(signature.statement || '').includes('验收通过')) errors.push('签字结论必须是「验收通过」');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(signature.date || '')) || Number.isNaN(Date.parse(signature.date))) {
      errors.push('签字日期必须是有效的 YYYY-MM-DD');
    }
    if (!String(signature.name || '').trim()) errors.push('签字人不能为空');
  }
  if (!String(manifest.runAt || '').trim() || Number.isNaN(Date.parse(manifest.runAt))) {
    errors.push('runAt 必须是有效的 ISO 时间');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(String(manifest.environment?.commit || ''))) {
    errors.push('environment.commit 必须是 git 提交哈希');
  }

  const evidence = manifest.evidence || {};
  checkEvidence(errors, baseDir, 'evidence.extraction', evidence.extraction, {json: true});
  checkEvidence(errors, baseDir, 'evidence.review', evidence.review, {json: true});
  checkEvidence(errors, baseDir, 'evidence.auditExport', evidence.auditExport, {json: true});
  checkEvidence(errors, baseDir, 'evidence.taskLog', evidence.taskLog);
  for (const key of ['list', 'detail', 'uiTaskCard', 'uiAuditReview', 'uiForceConfirm']) {
    checkEvidence(errors, baseDir, 'evidence.screenshots.' + key, evidence.screenshots?.[key]);
  }

  const snapshots = {};
  for (const key of ['before', 'after', 'afterUndo']) {
    const entry = evidence.db?.[key];
    const checked = checkEvidence(errors, baseDir, 'evidence.db.' + key, entry);
    if (!checked) continue;
    let actual;
    try { actual = contentHashOf(checked.file); }
    catch (error) { errors.push('evidence.db.' + key + ' 不是可读的 SQLite 库：' + String(error.message || error)); continue; }
    snapshots[key] = actual;
    if (!SHA256.test(String(entry.contentHash || '')) || entry.contentHash !== actual.hash) {
      errors.push('evidence.db.' + key + '.contentHash 与库内容不一致（实际 ' + actual.hash + '）');
    }
    if (entry.events !== actual.events || entry.projects !== actual.projects) {
      errors.push('evidence.db.' + key + ' 的行数与库内容不一致（实际 events=' + actual.events + ' projects=' + actual.projects + '）');
    }
  }
  if (snapshots.before && snapshots.afterUndo) {
    if (snapshots.before.hash !== snapshots.afterUndo.hash) errors.push('撤销前后快照内容哈希不一致');
    if (snapshots.before.events !== snapshots.afterUndo.events || snapshots.before.projects !== snapshots.afterUndo.projects) {
      errors.push('撤销前后行数不一致');
    }
  }

  const checks = manifest.checks || {};
  checkNumber(errors, checks, 'browserReads', value => value === 2, '浏览器读取必须是 2 次');
  checkNumber(errors, checks, 'collectorRuns', value => value === 0, '采集器调用必须是 0 次');
  checkNumber(errors, checks, 'fetchTextCalls', value => value === 0, 'fetchText 直连必须是 0 次');
  checkNumber(errors, checks, 'events', value => value >= 1, '活动至少写入 1 场');
  checkNumber(errors, checks, 'projects', value => value >= 1, '单位至少写入 1 个');
  checkNumber(errors, checks, 'contactFields', value => value === 0, '联系方式必须是 0 条');
  checkNumber(errors, checks, 'auditRows', value => value >= 1, '审计至少要有一条');
  checkNumber(errors, checks, 'conflictSkipped', value => value >= 1, '冲突用例至少有 1 条 skip');
  checkNumber(errors, checks, 'forced', value => value >= 1, '强制撤销至少写回 1 条');
  checkNumber(errors, checks, 'duplicateRows', value => value === 0, '不能有重复行');
  checkNumber(errors, checks, 'durationMs', value => value > 0 && value <= 15 * 60 * 1000, '整任务必须 ≤15 分钟');
  if (checks.auditDataRatio !== '1:1') errors.push('审计与数据行必须 1:1');
  if (checks.undoCleanMatchesBefore !== true) errors.push('干净撤销必须与验收前快照一致');
  if (checks.companyDbCreated !== false) errors.push('不能创建 company.db');

  if (snapshots.after) {
    if (checks.events !== snapshots.after.events) errors.push('checks.events 与写后库快照不一致');
    if (checks.projects !== snapshots.after.projects) errors.push('checks.projects 与写后库快照不一致');
  }
  if (manifest.agentLeg?.passed !== true) errors.push('外部 Agent 复核路径必须记为通过（passed=true）');
  if (!String(manifest.agentLeg?.tool || '').trim()) errors.push('缺少复核工具名 agentLeg.tool');

  return {ok: errors.length === 0, errors, snapshots};
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--hash-db') {
    const file = args[1];
    if (!file || !existsSync(file)) {
      console.error('用法：node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db <recruit.db>');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(contentHashOf(file), null, 2));
    }
  } else {
    const file = args[0] || resolve(dirname(fileURLToPath(import.meta.url)), 'manifest.json');
    if (!existsSync(file)) {
      console.error('找不到 manifest：' + file + '（先复制 manifest.template.json 并填写）');
      process.exitCode = 1;
    } else {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const result = await verifyManifest(manifest, {baseDir: dirname(resolve(file))});
      if (result.ok) {
        console.log('证据包校验通过：' + file);
      } else {
        console.error('证据包校验不通过：');
        for (const error of result.errors) console.error('- ' + error);
        process.exitCode = 2;
      }
    }
  }
}
