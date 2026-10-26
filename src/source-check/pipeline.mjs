// 来源校对任务：来源卡发起 → 应用内浏览器读列表与一场详情各一次并截图 →
// 视觉模型 API 只依据截图抽取 → 写网关只写 events / event_projects → 审计。
// 不调用采集器、不向目标站发直连 HTTP 请求、不写公司档案库；失败即整体回滚（fail closed）。
// 外部 Agent 文本复核（#40）不在本票内；复核接缝留在抽取之后、写入之前：
// reviewer({extraction, screenshots, source, signal}) 的结果只进证据，不修改写入集。
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RecruitStore} from '../recruit/store.mjs';
import {SOURCES, sourceById} from '../recruit/sources/index.mjs';
import {createWriteGateway} from '../writes/gateway.mjs';
import {bulkWriteRows} from '../recruit/bulk.mjs';
import {createVisionExtractor, normalizeExtraction} from './extract.mjs';
import {summarizeTaskUndo} from '../writes/undo.mjs';
import {SourceCheckBlockedError, readSourcePages} from './browser.mjs';
import {fallbackReviewCall, parseReviewIssues, REVIEW_MAX_RAW} from './review.mjs';
import {sourceCheckEnabled, normalizeSourceCheckUrl} from './config.mjs';

// 'swufe' 是首验约定的别名，归一化到真实源 id；来源校对已泛化到任意已开放源与任意 URL。
export const SOURCE_CHECK_ALIASES = {swufe: 'swufe-xjh', 'swufe-xjh': 'swufe-xjh'};
export const SOURCE_CHECK_NOTES = '浏览器截图读取（非采集器）';
export const SOURCE_CHECK_REASON = '采集器已禁用（robots 限制），改用应用内浏览器读取';
export const SOURCE_CHECK_STATUS = '采集器已禁用，改用应用内浏览器读取；不会调用采集器，也不会向目标站发直连请求。';
export const SOURCE_CHECK_ACTOR = 'model_api';
const EVIDENCE_FILES = /^(01-list\.png|02-detail\.png|screenshots\.json|extraction\.json|review\.json|action\.jsonl|action-\d{3}\.png|wechat-[a-z0-9-]+\.json)$/;

export function resolveSource(sourceId) {
  const key = SOURCE_CHECK_ALIASES[String(sourceId || '').trim()];
  const id = key || String(sourceId || '').trim();
  if (!id) return null;
  try {
    const source = sourceById(id);
    return source && sourceCheckEnabled(source) ? source : null;
  } catch {
    return null;
  }
}

// 来源校对目标解析：要么是任意 URL（合成一个 manual 源），要么是已开放来源校对的已知源。
// 只接受 http/https；未知源 / 非法 URL 返回 {error}，由调用方映射成 400。
export function resolveSourceCheckTarget({sourceId, url} = {}) {
  const rawUrl = String(url || '').trim();
  if (rawUrl) {
    const normalized = normalizeSourceCheckUrl(rawUrl);
    if (!normalized) {
      return {error: {code: 'INVALID_URL', message: '来源校对只接受 http/https 链接；请粘贴活动/招聘会的列表页地址。'}};
    }
    let host = '';
    try { host = new URL(normalized).hostname; } catch { /* 归一化已保证可解析 */ }
    return {
      kind: 'url',
      source: {
        id: 'manual',
        name: host || '任意网页',
        school: '',
        city: '',
        kind: '',
        listUrl: normalized,
        arbitrary: true,
        sourceCheck: {enabled: true}
      }
    };
  }
  const source = resolveSource(sourceId);
  if (!source) {
    return {error: {code: 'UNSUPPORTED_SOURCE', message: '这个来源还不支持来源校对。'}};
  }
  return {kind: 'source', source};
}

export function userDataDir(dataDir, userId) {
  return join(String(dataDir), 'users', String(userId), '.data');
}

export function evidenceDirFor(dataDir, userId, taskId) {
  return join(String(dataDir), 'users', String(userId), 'tasks', String(taskId), 'evidence');
}

export function evidenceUrl(taskId, file) {
  return '/api/source-check/evidence?taskId=' + encodeURIComponent(String(taskId)) + '&file=' + encodeURIComponent(String(file));
}

export function idempotencyKeyFor(taskId, step = 'write') {
  return 'source-check:' + String(taskId) + ':' + String(step);
}

function openStore(dataDir, userId) {
  return RecruitStore.open(join(userDataDir(dataDir, userId), 'recruit.db'));
}

// 来源卡上的「最近手动读取」与原因；与采集器的 last_run / last_status 分开存，互不覆盖。
export function recordManualRead({dataDir, userId, sourceId, taskId = '', sessionId = '', status = 'succeeded', reason = SOURCE_CHECK_REASON}) {
  const store = openStore(dataDir, userId);
  try {
    store.recordManualRead({sourceId, taskId, sessionId, status, reason});
  } finally {
    store.close();
  }
}

// 一次写工具调用 = 一个批次：业务行 + 审计 + 幂等同库同事务；只写 events / event_projects。
export async function writeSourceCheck({dataDir, userId, taskId, extraction, source = {}, screenshots = [], actorRef = ''}) {
  const store = openStore(dataDir, userId);
  try {
    const detail = screenshots.find(shot => shot.id === 'detail') || screenshots.at(-1) || null;
    const detailUrl = source.detailUrl || detail?.url || extraction?.source?.detailUrl || source.listUrl || '';
    const sourceMeta = {sourceId: 'manual', sourceUrl: detailUrl, notes: SOURCE_CHECK_NOTES};
    const detailFile = String(detail?.file || '02-detail.png');
    const sourceRef = 'artifact:' + basename(detailFile);
    const gateway = createWriteGateway({
      db: store.db,
      domain: 'recruit',
      userId: String(userId),
      actorType: SOURCE_CHECK_ACTOR,
      actorRef: String(actorRef || ''),
      taskId: String(taskId)
    });
    // 活动行的 notes 在 #29 的 eventRecord 里只读 sourceNotes；这里显式带上，确保在库里标明非采集器。
    const events = (Array.isArray(extraction?.events) ? extraction.events : []).map(event => ({...event, notes: event.notes !== undefined ? event.notes : SOURCE_CHECK_NOTES}));
    const projects = Array.isArray(extraction?.projects) ? extraction.projects : [];
    return await gateway.write({
      tool: 'career_recruit_bulk_write',
      sensitivity: 'auto',
      payload: {events, projects, source: sourceMeta},
      idempotencyKey: idempotencyKeyFor(taskId, 'write'),
      sourceRef,
      entity: 'events',
      action: 'create',
      execute: () => bulkWriteRows({store, events, projects, source: sourceMeta})
    });
  } finally {
    store.close();
  }
}

function evidenceDetail(shot) {
  const viewport = shot.viewport || {};
  return 'URL ' + String(shot.url || '') + ' · ' + String(shot.at || '') + ' · 视口 ' + String(viewport.width || '') + '×' + String(viewport.height || '');
}

function publicReview(review) {
  if (!review) return null;
  const out = {...review};
  delete out.call;
  return out;
}

// 抽取之后、写库之前的文本复核：建议制——问题只进证据与任务卡，写入集与审计一点都不改。
// 复核不可用时任务继续，写库照常；Agent 支路记为未通过（agentLeg=failed）。
async function runReview({reviewer, extraction, source, screenshots, signal, taskId, evidenceDir, addEvidence, emit}) {
  if (typeof reviewer !== 'function') return null;
  const started = Date.now();
  let out = null;
  let error = null;
  try {
    out = await reviewer({extraction, screenshots, source, signal});
  } catch (caught) {
    error = caught;
  }
  if (!error && out && out.ok === false) {
    error = Object.assign(new Error(out.error?.message || '外部 Agent 复核失败'), out.error || {}, {
      agent: out.agent || null, tool: out.tool || '', call: out.call || null
    });
  }
  const durationMs = Date.now() - started;
  const at = new Date().toISOString();
  let review;
  if (error) {
    const code = String(error.code || 'REVIEW_FAILED').slice(0, 60);
    const call = error.call || (error.attempted === false ? null : fallbackReviewCall({
      agent: error.agent || out?.agent || null, tool: error.tool || out?.tool || '', durationMs, outcome: 'failed', errorCode: code
    }));
    review = {
      status: 'unavailable',
      count: 0,
      issues: [],
      agentLeg: 'failed',
      attempted: Boolean(call),
      agent: error.agent || out?.agent || null,
      tool: error.tool || out?.tool || '',
      error: {
        code,
        message: String(error.message || '外部 Agent 复核不可用').slice(0, 500),
        recovery: String(error.recovery || '检查外部 Agent 配置与网络后重试；写库不受影响。').slice(0, 300)
      },
      at,
      call
    };
    if (call) {
      const payload = {status: review.status, issues: [], raw: '', agent: review.agent, tool: review.tool, error: review.error, at};
      await writeFile(join(evidenceDir, 'review.json'), JSON.stringify(payload, null, 2), 'utf8');
      await addEvidence({
        kind: 'review',
        label: '外部 Agent 复核不可用：' + code,
        detail: review.error.message + '（' + review.error.recovery + '）',
        url: evidenceUrl(taskId, 'review.json')
      });
    }
  } else {
    const text = String(out?.text ?? out?.raw ?? '');
    const issues = Array.isArray(out?.issues) ? out.issues : parseReviewIssues(text);
    const status = issues === null ? 'unparsed' : issues.length ? 'issues' : 'clean';
    const call = out?.call || fallbackReviewCall({
      agent: out?.agent || null, tool: out?.tool || '', durationMs, outcome: 'ok'
    });
    review = {
      status,
      count: issues === null ? 0 : issues.length,
      issues: issues === null ? [] : issues,
      raw: issues === null ? text.slice(0, REVIEW_MAX_RAW) : '',
      agentLeg: 'passed',
      attempted: true,
      agent: out?.agent || null,
      tool: out?.tool || '',
      at,
      call
    };
    const payload = {status, issues: review.issues, raw: review.raw, agent: review.agent, tool: review.tool, at};
    await writeFile(join(evidenceDir, 'review.json'), JSON.stringify(payload, null, 2), 'utf8');
    const label = status === 'issues'
      ? '外部 Agent 复核：' + review.count + ' 个问题'
      : status === 'unparsed' ? '外部 Agent 复核：已复核（未解析出问题列表）' : '外部 Agent 复核：未发现问题';
    await addEvidence({
      kind: 'review',
      label,
      detail: status === 'issues'
        ? review.issues.slice(0, 5).map(item => (item.row || '') + (item.field ? ' · ' + item.field : '') + '：' + item.issue).join('\n')
        : status === 'unparsed' ? review.raw.slice(0, 400) : '复核建议制：未发现问题；写入集未被修改。',
      url: evidenceUrl(taskId, 'review.json')
    });
  }
  emit({type: 'review', taskId, review: publicReview(review)});
  return review;
}

function screenshotMeta(shot) {
  return {
    id: shot.id,
    kind: 'screenshot',
    file: basename(shot.file),
    url: String(shot.url || ''),
    title: String(shot.title || ''),
    at: shot.at || new Date().toISOString(),
    viewport: {width: Number(shot.viewport?.width) || 1366, height: Number(shot.viewport?.height) || 900}
  };
}

// 抽取 → 复核 → 写库：确定性 source-check 与手动 AI 兜底共用这一段写路径与证据，
// 两条路径只有「截图从哪来」不同（固定两页 / operator 动作截图），记录字段与审计口径一致。
export async function runExtractionAndWrite({
  dataDir, userId, task, source = {}, shots = [], models = {}, extractor = null, reviewer = null,
  actorRef = '', signal, emit = () => {}, addEvidence = async () => {}, setPhase = () => {},
  evidenceDir = '', addScreenshotEvidence = true, label = '来源校对'
} = {}) {
  const dir = evidenceDir || evidenceDirFor(dataDir, userId, task.id);
  await mkdir(dir, {recursive: true});
  const usable = Array.isArray(shots) ? shots.filter(shot => shot?.file) : [];
  if (usable.length !== 2) {
    throw Object.assign(new Error('没有拿到列表页与详情页两张截图，未写入任何数据。'), {
      code: 'SOURCE_SCREENSHOTS_MISSING',
      recovery: '重试一次；仍失败就改用手动导入。'
    });
  }
  const screenshots = usable.map(screenshotMeta);
  await writeFile(join(dir, 'screenshots.json'), JSON.stringify(screenshots, null, 2), 'utf8');
  if (addScreenshotEvidence) {
    for (const shot of screenshots) {
      await addEvidence({
        kind: 'screenshot',
        label: (shot.id === 'list' ? '截图 1 · 列表页：' : '截图 2 · 活动详情：') + (shot.title || ''),
        detail: evidenceDetail(shot),
        url: evidenceUrl(task.id, shot.file)
      });
    }
  }

  setPhase('正在用视觉模型 API 依据截图抽取活动与单位…');
  const raw = extractor
    ? await extractor({screenshots: usable, source, models, signal})
    : await createVisionExtractor({config: models})({screenshots: usable, source, signal});
  const detailShot = screenshots.find(shot => shot.id === 'detail');
  const detailUrl = detailShot?.url || '';
  const detailTitle = detailShot?.title || '';
  const extraction = normalizeExtraction(raw, {source, detailUrl, detailTitle});
  await writeFile(join(dir, 'extraction.json'), JSON.stringify(extraction, null, 2), 'utf8');
  const skipped = Number(extraction.skipped?.events || 0) + Number(extraction.skipped?.projects || 0);
  await addEvidence({
    kind: 'extraction',
    label: '抽取 JSON（联系方式已剔除）',
    detail: '活动 ' + extraction.events.length + ' · 单位 ' + extraction.projects.length + (skipped ? ' · 跳过不可读 ' + skipped : ''),
    url: evidenceUrl(task.id, 'extraction.json')
  });
  if (!extraction.events.length) {
    throw Object.assign(new Error('截图里没有读到可写入的活动，未写入任何数据。'), {code: 'SOURCE_NO_EVENTS_READ', recovery: '在普通浏览器人工核对后手动导入；不要靠猜补字段。'});
  }

  // 复核在写库之前：只发送抽取 JSON 与来源元数据；问题不改写入集，失败也不阻断写库。
  setPhase('正在请外部 Agent 文本复核抽取结果…');
  const review = await runReview({
    reviewer, extraction, source, screenshots: usable, signal,
    taskId: task.id, evidenceDir: dir, addEvidence, emit
  });

  setPhase('正在写入本机招聘库…');
  const write = await writeSourceCheck({dataDir, userId, taskId: task.id, extraction, source, screenshots: usable, actorRef});
  if (write.duplicate) {
    emit({type: 'status', text: '这批写入此前已经完成（幂等重放），没有新增数据。'});
  } else {
    emit({type: 'writes', taskId: task.id, tool: 'career_recruit_bulk_write', batchId: write.batchId, counts: write.counts});
  }
  setPhase(label + '完成：已写入活动 ' + extraction.events.length + ' 条、单位 ' + extraction.projects.length + ' 条。');
  return {extraction, write, screenshots, review};
}

// 单次任务的执行体：说明 → 浏览器两页 → 视觉抽取 → 文本复核 → 写库；阻断则标 blocked 并保留恢复建议。
export async function runSourceCheck({dataDir, userId, task, source, models = {}, browserReader = readSourcePages, extractor = null, reviewer = null, actorRef = '', signal, emit = () => {}, addEvidence = async () => {}, setPhase = () => {}}) {
  const evidenceDir = evidenceDirFor(dataDir, userId, task.id);
  await mkdir(evidenceDir, {recursive: true});
  emit({type: 'status', text: SOURCE_CHECK_STATUS});
  await addEvidence({kind: 'note', label: SOURCE_CHECK_REASON, detail: '明确不调用采集器，也不向目标站发 fetchText / HTTP 抓取；只由应用内浏览器打开两次页面。'});
  setPhase('正在用应用内浏览器打开来源列表页…');

  let read;
  try {
    read = await browserReader({source, evidenceDir, signal});
  } catch (error) {
    if (error instanceof SourceCheckBlockedError || error?.name === 'SourceCheckBlockedError' || error?.blocked === true) {
      const reason = String(error.reason || error.message || '来源页需要登录或验证，已停止读取。').slice(0, 200);
      const recovery = String(error.recovery || '改用公众号文章转发或手动导入；不要绕过登录或验证码。').slice(0, 200);
      emit({type: 'blocked', code: String(error.code || 'SOURCE_BLOCKED'), reason, recovery});
      return {blocked: true, reason, recovery};
    }
    throw error;
  }

  const shots = Array.isArray(read?.screenshots) ? read.screenshots.filter(shot => shot?.file) : [];
  return runExtractionAndWrite({
    dataDir, userId, task, source, shots, models, extractor, reviewer, actorRef, signal,
    emit, addEvidence, setPhase, evidenceDir, label: '来源校对'
  });
}

// 来源校对任务没有对话轮次，但复核调用记录必须挂在助手消息的调用表里（step=review）。
// 这里在任务收尾后补一条合成助手消息；只写会话消息，不写 workbench/任务记忆记录。
function reviewMessage(review, extraction) {
  const wrote = '来源校对完成：写入活动 ' + (extraction?.events?.length || 0) + ' 条、单位 ' + (extraction?.projects?.length || 0) + ' 条。';
  if (!review) return wrote;
  if (review.status === 'unavailable') {
    return wrote + ' 外部 Agent 复核不可用（' + review.error?.code + '）：' + review.error?.message + '；数据已照常写入。';
  }
  if (review.status === 'issues') return wrote + ' 外部 Agent 复核 ' + review.count + ' 个问题（建议制，未修改写入集）。';
  if (review.status === 'unparsed') return wrote + ' 外部 Agent 已复核，但没有返回可解析的问题列表。';
  return wrote + ' 外部 Agent 复核未发现问题。';
}

async function appendReviewMessage({dataDir, userId, sessionId, review, extraction}) {
  if (!review?.call) return;
  const file = join(userDataDir(dataDir, userId), String(sessionId) + '.json');
  let session;
  try { session = JSON.parse(await readFile(file, 'utf8')); } catch { return; }
  session.messages = Array.isArray(session.messages) ? session.messages : [];
  session.messages.push({
    role: 'assistant',
    backend: review.call.backend?.label || '外部 Agent 复核',
    backendKind: 'agent',
    calls: [review.call],
    content: reviewMessage(review, extraction),
    durationMs: Number(review.call.durationMs) || 0,
    at: review.call.at
  });
  session.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(session, null, 2), 'utf8');
}

// 供 /api/source-check/start 使用的服务：创建会话 + 排队/运行任务，立即返回 id 供数据页跳转。
export function createSourceCheckService({dataDir, taskManager, browserReader = readSourcePages, extractor = null, visionCall = null, reviewer = null, reviewerFactory = null} = {}) {
  if (!dataDir) throw new Error('来源校对服务需要 dataDir');
  if (!taskManager) throw new Error('来源校对服务需要任务管理器');

  async function start({user, models = {}, sourceId, url}) {
    const target = resolveSourceCheckTarget({sourceId, url});
    if (target.error) {
      return {status: 400, json: {error: target.error.message, code: target.error.code}};
    }
    const source = target.source;
    const sourceLabel = source.school || source.name || '来源校对';
    const session = {
      id: randomUUID(),
      title: '来源校对 · ' + sourceLabel,
      memory: '',
      messages: [],
      artifacts: [],
      updatedAt: new Date().toISOString()
    };
    await mkdir(userDataDir(dataDir, user.id), {recursive: true});
    await writeFile(join(userDataDir(dataDir, user.id), session.id + '.json'), JSON.stringify(session, null, 2), 'utf8');

    let resolveCreated;
    const created = new Promise(resolve => { resolveCreated = resolve; });
    const run = taskManager.run({
      userId: user.id,
      sessionId: session.id,
      title: '来源校对 · ' + sourceLabel + ' · ' + (source.kind || '活动'),
      sourceName: sourceLabel,
      describeUndo: ({task}) => summarizeTaskUndo({dir: userDataDir(dataDir, user.id), userId: user.id, taskId: task.id}),
      onCreate: task => resolveCreated(task),
      execute: async ({task, signal, emit, addEvidence, setPhase}) => {
        let result = null;
        let userReviewer = reviewer;
        if (!userReviewer && typeof reviewerFactory === 'function') {
          try { userReviewer = await reviewerFactory({userId: user.id, task, emit, signal}); }
          catch { userReviewer = null; }
        }
        try {
          result = await runSourceCheck({
            dataDir, userId: user.id, task, source, models, signal, emit, addEvidence, setPhase,
            browserReader, extractor: extractor || (visionCall ? createVisionExtractor({config: models, visionCall}) : null),
            reviewer: userReviewer,
            actorRef: models?.label || ''
          });
          if (result?.review?.call) {
            await appendReviewMessage({dataDir, userId: user.id, sessionId: session.id, review: result.review, extraction: result.extraction}).catch(() => {});
          }
          return result;
        } finally {
          // 来源卡记录失败不能反过来把已完成的写入判成失败。
          try {
            recordManualRead({
              dataDir, userId: user.id, sourceId: source.id, taskId: task.id, sessionId: session.id,
              status: result?.blocked ? 'blocked' : result ? 'succeeded' : 'failed',
              reason: SOURCE_CHECK_REASON
            });
          } catch { /* 最近手动读取只是展示信息 */ }
        }
      }
    });
    run.catch(() => {});
    const task = await created;
    return {
      status: 200,
      json: {
        ok: true,
        sourceId: source.id,
        sessionId: session.id,
        taskId: task.id,
        title: session.title,
        reason: SOURCE_CHECK_REASON,
        workflow: 'open'
      }
    };
  }

  // 证据文件只从本人任务目录里取，文件名白名单，杜绝路径穿越。
  async function readEvidence({userId, taskId, file} = {}) {
    if (!/^[a-f0-9-]{36}$/.test(String(taskId || ''))) return null;
    if (!EVIDENCE_FILES.test(String(file || ''))) return null;
    const path = join(evidenceDirFor(dataDir, userId, taskId), String(file));
    try {
      const body = await readFile(path);
      return {type: file.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8', body};
    } catch {
      return null;
    }
  }

  return {start, readEvidence};
}

