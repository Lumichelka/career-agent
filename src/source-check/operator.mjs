// 来源操作员（operator）的任务核心：
// - 应用内 per-user persistent profile，可见窗口登录；
// - 把 AI/playbook 给出的步骤逐条执行，每步写 action.jsonl + 截图；
// - 登录/验证码/异常/时间上限暂停为 waiting_login / waiting_human，人工处理后再从停点继续；
// - 投递/支付/删除/退出/提交表单暂停硬确认；禁下载/上传/特殊 scheme/私网；允许剪贴板与任意 Playwright/JS。
// 安全边界是「单用户本机 + 手动触发 + 可见窗口 + 每次确认」，不是沙箱，也不承诺防任意 JS 绕过。
import {mkdir, appendFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {isPrivateSourceHost} from './config.mjs';
import {detectBlock} from './browser.mjs';
import {operatorProfileDir} from '../config/paths.mjs';
import {resolveSourceCheckTarget, evidenceDirFor, userDataDir, recordManualRead} from './pipeline.mjs';
import {loadPlaybook, playbookMatchesSource, playbookSteps, AI_FALLBACK_NOTE} from './playbook.mjs';

export {operatorProfileDir};

// 单次 AI 操作（从开始/上次人工续跑到下一次暂停）的硬上限：<10 分钟。
export const OPERATOR_MAX_ACTIVE_MS = 10 * 60 * 1000;

// AI 兜底是手动入口（ADR 0003）：来源卡上的原因文案与任务标题都用这一句，避免被当成自动采集。
export const AI_FALLBACK_REASON = 'AI 兜底（手动）：' + AI_FALLBACK_NOTE;
export const AI_FALLBACK_TITLE_PREFIX = 'AI 兜底 · ';

// 启动与上下文参数是公开契约：必须可见（headless:false）、禁用下载、授予剪贴板读写。
export const OPERATOR_LAUNCH_OPTIONS = {
  channel: 'msedge',
  headless: false,
  locale: 'zh-CN',
  viewport: {width: 1366, height: 900},
  acceptDownloads: false,
  permissions: ['clipboard-read', 'clipboard-write']
};

const BLOCKED_SCHEME = /^(file|chrome|chrome-extension|edge|about|javascript|data|blob|view-source|devtools|moz-extension|ms-browser-extension):/i;

function blockedUrl(reason) {
  return {ok: false, code: 'OPERATOR_URL_BLOCKED', reason: String(reason).slice(0, 300)};
}

// 操作员唯一允许的页面地址：http/https，且默认拒绝 localhost/私网/链路本地。
// 这是字面判断，不做 DNS 解析；DNS rebinding 不在本票承诺内。
export function checkOperatorUrl(url, {allowPrivate = false} = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return blockedUrl('地址为空，不能打开。');
  if (BLOCKED_SCHEME.test(raw)) return blockedUrl('不允许打开特殊协议地址：' + raw.slice(0, 80));
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return blockedUrl('不是合法的 http/https 地址：' + raw.slice(0, 120));
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return blockedUrl('只允许 http/https 地址。');
  if (!allowPrivate && isPrivateSourceHost(parsed.hostname)) {
    return blockedUrl('不允许访问本机或私网地址：' + parsed.hostname);
  }
  return {ok: true, url: parsed.href};
}

const DANGER_PATTERNS = [
  {kind: 'logout', reason: '退出登录', re: /(退出登录|登出|退出账号|注销账号|log\s*out|sign\s*out)/i},
  {kind: 'payment', reason: '支付/付款', re: /(支付|付款|缴费|购买|下单|结算|pay|checkout|purchase)/i},
  {kind: 'delete', reason: '删除/清空', re: /(删除|清空|移除|delete|remove|clear)/i},
  {kind: 'apply', reason: '投递/申请', re: /(投递|申请|应聘|报名|apply)/i},
  {kind: 'submit', reason: '提交表单', re: /(提交|保存|发布|确认|submit|send)/i}
];

// 危险动作的「尽力而为」硬确认：只对点击/提交/按键生效，命中即暂停等用户确认。
// 提示词与 selector 都可能被页面误导；这里不承诺防任意 JS 绕过。
export function classifyDangerousAction(step = {}) {
  const action = String(step.action || '').toLowerCase();
  if (!['click', 'submit', 'press'].includes(action)) return {dangerous: false};
  if (action === 'submit') {
    return {dangerous: true, kind: 'submit', reason: '提交表单', text: String(step.text || step.label || step.target || '')};
  }
  const text = [step.text, step.label, step.target].filter(Boolean).join(' ');
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.re.test(text)) {
      return {dangerous: true, kind: pattern.kind, reason: pattern.reason, text};
    }
  }
  return {dangerous: false};
}

export function actionScreenshotName(step) {
  return 'action-' + String(Number(step) || 0).padStart(3, '0') + '.png';
}

// 真实启动入口：persistent context 的 userDataDir 就是 per-user profile；
// 不启动 stealth，不伪装 UA，不做反检测。
export async function launchOperatorBrowser({profileDir, options = {}} = {}) {
  if (!profileDir) throw new Error('operator 需要 profileDir');
  await mkdir(profileDir, {recursive: true});
  const merged = {...OPERATOR_LAUNCH_OPTIONS, ...options, acceptDownloads: false};
  return chromium.launchPersistentContext(profileDir, merged);
}

export const OPERATOR_ACTIONS = ['goto', 'click', 'fill', 'press', 'evaluate', 'wait', 'screenshot', 'submit', 'playwright'];

export class OperatorError extends Error {
  constructor(code, message, recovery = '') {
    super(String(message || '来源操作失败').slice(0, 500));
    this.name = 'OperatorError';
    this.code = code;
    if (recovery) this.recovery = String(recovery).slice(0, 300);
  }
}

function operatorAbortError() {
  const error = new Error('本次任务已停止。');
  error.name = 'AbortError';
  error.code = 'CANCELLED';
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(operatorAbortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(operatorAbortError()); }, {once: true});
  });
}

function operatorEvidenceUrl(taskId, file) {
  return '/api/source-check/evidence?taskId=' + encodeURIComponent(String(taskId)) + '&file=' + encodeURIComponent(String(file));
}

function actionTarget(step) {
  if (step.target) return String(step.target);
  if (step.action === 'playwright') return String(step.label || '任意 Playwright');
  if (step.url) return String(step.url);
  if (step.script) return String(step.script).slice(0, 160);
  return String(step.label || '');
}

// 步骤是 AI/playbook 产出的普通 JSON；未知 action 直接拒绝，不猜测。
export function normalizeOperatorStep(step, index = 0) {
  if (!step || typeof step !== 'object') throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步不是对象。');
  const action = String(step.action || '').toLowerCase();
  if (!OPERATOR_ACTIONS.includes(action)) throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步的 action 不支持：' + action);
  const out = {...step, action};
  if (action === 'goto') {
    const checked = checkOperatorUrl(step.url);
    if (!checked.ok) throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步地址被拒绝：' + checked.reason);
    out.url = checked.url;
  }
  if (['click', 'fill', 'press', 'submit'].includes(action) && !String(step.target || '').trim()) {
    throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步缺少 target。');
  }
  if (action === 'fill' && typeof step.value !== 'string') throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步缺少要填入的文本。');
  if (action === 'press' && !String(step.key || '').trim()) throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步缺少按键。');
  if (action === 'evaluate' && !String(step.script || '').trim()) throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步缺少 JS。');
  // 程序内注入的步骤可以直接拿 page 执行任意 Playwright；HTTP 的 JSON 步骤只能走 evaluate/固定动作。
  if (action === 'playwright' && typeof step.perform !== 'function') throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步缺少 Playwright 执行函数。');
  if (action === 'wait') {
    const ms = Number(step.ms);
    if (!Number.isFinite(ms) || ms < 0) throw new OperatorError('INVALID_OPERATOR_STEP', '第 ' + (index + 1) + ' 步等待时长无效。');
    out.ms = Math.min(60000, Math.round(ms));
  }
  return out;
}

export function normalizeOperatorSteps(steps, {source = {}} = {}) {
  if (!Array.isArray(steps) || !steps.length) {
    return [{action: 'goto', url: source.listUrl}, {action: 'screenshot', label: '来源列表'}]
      .map((step, index) => normalizeOperatorStep(step, index));
  }
  if (steps.length > 200) throw new OperatorError('INVALID_OPERATOR_STEP', '一次最多 200 步。');
  return steps.map((step, index) => normalizeOperatorStep(step, index));
}

function flagPolicy(state, kind, reason) {
  if (!state.blocked) state.blocked = {kind, reason: String(reason).slice(0, 300)};
}

// 页面级护栏：下载/上传/特殊协议/私网请求命中即标记，由执行循环暂停转人工。
// 这个护栏是「尽力而为」：页面上的任意 JS 仍可能绕过浏览器事件，ADR 0001 已接受该风险。
function attachOperatorGuards({page, context, policyState}) {
  try {
    page.on('download', async download => {
      flagPolicy(policyState, 'download', '页面触发了下载，已拦截；下载不在本任务允许范围内。');
      try { await download.cancel(); } catch { /* 已取消失败也不继续下载 */ }
    });
  } catch { /* 假页面/受限上下文没有这个事件 */ }
  try {
    page.on('filechooser', async chooser => {
      flagPolicy(policyState, 'upload', '页面打开了文件选择器，已拦截；上传不在本任务允许范围内。');
      try { await chooser.setFiles([]); } catch { /* 清空失败也不能上传 */ }
    });
  } catch { /* 同上 */ }
  try {
    context.route?.('**/*', async route => {
      const requestUrl = String(route.request?.()?.url?.() || '');
      const checked = checkOperatorUrl(requestUrl);
      if (!checked.ok) {
        flagPolicy(policyState, 'url', checked.reason);
        if (typeof route.abort === 'function') return route.abort('blockedbyclient');
        return;
      }
      if (typeof route.continue === 'function') return route.continue();
    });
  } catch { /* 不支持 route 的上下文由 goto 与登录检测兜底 */ }
  try {
    page.on('request', request => {
      const checked = checkOperatorUrl(request?.url?.());
      if (!checked.ok) flagPolicy(policyState, 'url', checked.reason);
    });
  } catch { /* 同上 */ }
  // 任意 JS 也可能用 location 跳到特殊协议；主框架跳转后再兜底一次，命中即暂停。
  try {
    page.on('framenavigated', frame => {
      const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
      if (main && frame !== main) return;
      const frameUrl = String(frame?.url?.() || '');
      if (!frameUrl || frameUrl === 'about:blank') return; // 浏览器初始空白页不是 AI 打开的地址
      const checked = checkOperatorUrl(frameUrl);
      if (!checked.ok) flagPolicy(policyState, 'url', checked.reason);
    });
  } catch { /* 同上 */ }
}

async function detectOperatorPause(page) {
  const url = String(page?.url?.() || '');
  let title = '';
  let text = '';
  try { title = String(await page.title?.() || ''); } catch { title = ''; }
  try {
    text = String(await page.evaluate?.(() => String(document.body?.innerText || '').slice(0, 4000)) || '');
  } catch { text = ''; }
  const block = detectBlock({url, title, text});
  if (!block.blocked) return null;
  const captchaLike = /(验证码|安全验证|captcha|verify|人机验证)/i.test(title + ' ' + url + ' ' + text.slice(0, 1000));
  const loginLike = !captchaLike && (block.code === 'SOURCE_LOGIN_REQUIRED' || /(登录|login|sign\s*in)/i.test(title) || /\/(login|signin|passport|sso|auth)(\b|[/?#])/i.test(url));
  return loginLike
    ? {state: 'waiting_login', kind: 'login', reason: '页面需要登录，请在本窗口登录后点「已登录，继续」。' + String(block.reason || '').slice(0, 200)}
    : {state: 'waiting_human', kind: 'captcha', reason: '页面出现验证码或访问限制，请在本窗口处理后继续；不要绕过验证。'};
}

async function runOperatorStep(page, step, signal) {
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, {waitUntil: 'domcontentloaded', timeout: 45000});
      return;
    case 'click':
      await page.click(step.target, {timeout: 20000});
      return;
    case 'fill':
      await page.fill(step.target, step.value, {timeout: 20000});
      return;
    case 'press':
      if (step.target) await page.press(step.target, step.key, {timeout: 20000});
      else await page.keyboard.press(step.key);
      return;
    case 'evaluate': {
      // 允许任意 JS：提示词/脚本不是安全边界，风险见 ADR 0001。
      await page.evaluate(step.script, step.arg);
      return;
    }
    case 'wait':
      await delay(step.ms, signal);
      return;
    case 'screenshot':
      return; // 每步都会自动截图；显式 screenshot 只是插入一个带标签的关键帧。
    case 'submit':
      await page.locator(step.target).evaluate(form => form.requestSubmit ? form.requestSubmit() : form.submit());
      return;
    case 'playwright':
      // 任意 Playwright 动作：AI/playbook 可在进程内注入函数，不受固定动作表限制。
      // 返回值可以是一组后续步骤：用于「先读列表，再按列表逐篇打开」这类运行时才知道的计划。
      return await step.perform({page, signal});
    default:
      throw new OperatorError('INVALID_OPERATOR_STEP', '未知操作：' + step.action);
  }
}

async function takeStepScreenshot(page, evidenceDir, step) {
  const file = actionScreenshotName(step);
  try {
    await page.screenshot({path: join(evidenceDir, file), timeout: 20000});
    return file;
  } catch {
    return '';
  }
}

function actionLabel(step) {
  if (step.action === 'goto') return '打开页面';
  if (step.action === 'click') return '点击';
  if (step.action === 'fill') return '填写';
  if (step.action === 'press') return '按键';
  if (step.action === 'evaluate') return '执行 JS';
  if (step.action === 'wait') return '等待';
  if (step.action === 'screenshot') return '截图';
  if (step.action === 'submit') return '提交表单';
  if (step.action === 'playwright') return 'Playwright';
  return step.action;
}

// 执行一份步骤计划。askHuman 由服务层实现（落任务状态、等用户点继续/确认）；
// 这里只负责「从停点继续」：暂停时保留浏览器上下文，恢复后从当前步骤继续，不重跑已完成步骤。
export async function executeOperatorPlan({
  profileDir,
  evidenceDir,
  taskId,
  steps,
  source = {},
  launch = launchOperatorBrowser,
  maxActiveMs = OPERATOR_MAX_ACTIVE_MS,
  signal,
  emit = () => {},
  addEvidence = async () => {},
  setPhase = () => {},
  askHuman = async () => ({action: 'resume'}),
  now = Date.now
} = {}) {
  if (!profileDir) throw new OperatorError('INVALID_OPERATOR_RUN', 'operator 需要 profileDir。');
  if (!evidenceDir) throw new OperatorError('INVALID_OPERATOR_RUN', 'operator 需要证据目录。');
  const plan = normalizeOperatorSteps(steps, {source});
  await mkdir(evidenceDir, {recursive: true});
  await mkdir(profileDir, {recursive: true});
  const logFile = join(evidenceDir, 'action.jsonl');

  let context;
  try {
    context = await launch({profileDir, options: {...OPERATOR_LAUNCH_OPTIONS}});
  } catch (error) {
    throw new OperatorError('BROWSER_UNAVAILABLE', '应用内浏览器不可用：' + String(error?.message || error).slice(0, 200), '安装 Microsoft Edge 后重试；或改用手动导入。');
  }

  const page = (typeof context.pages === 'function' ? context.pages()[0] : null)
    || await context.newPage();
  const policyState = {blocked: null};
  attachOperatorGuards({page, context, policyState});
  const actions = [];
  const screenshots = [];
  let index = 0;
  let segmentStart = now();

  try {
    await writeFile(logFile, '', 'utf8');
    emit({type: 'operator_running', taskId, phase: '正在应用内浏览器执行操作', total: plan.length, step: 1});

    while (index < plan.length) {
      if (signal?.aborted) throw operatorAbortError();
      const step = plan[index];
      const stepNo = index + 1;

      // 单次操作硬上限：到点暂停为人工接管，用户续跑后重新计时；不判失败。
      if (now() - segmentStart >= maxActiveMs) {
        const answer = await askHuman({
          state: 'waiting_human', kind: 'timeout', step: stepNo, total: plan.length,
          reason: '单次操作已到 10 分钟上限，已暂停。你可以先处理后点「已处理，继续」从未完成步骤继续。'
        });
        if (answer?.action === 'cancel') throw operatorAbortError();
        segmentStart = now();
        emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '人工处理后继续操作'});
      }

      if (policyState.blocked) {
        const blocked = policyState.blocked;
        policyState.blocked = null;
        const answer = await askHuman({
          state: 'waiting_human', kind: 'policy', policyKind: blocked.kind,
          step: stepNo, total: plan.length, target: actionTarget(step), reason: blocked.reason
        });
        if (answer?.action === 'cancel') throw operatorAbortError();
        segmentStart = now();
        emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '人工处理后继续操作'});
      }

      // 每步收尾：截图 + action.jsonl + 任务证据 + 时间线事件；暂停前也要先落这一步。
      const recordStep = async ({result, reason = '', startedAt = new Date().toISOString(), started = now()}) => {
        const shot = await takeStepScreenshot(page, evidenceDir, stepNo);
        const entry = {
          step: stepNo,
          action: step.action,
          target: actionTarget(step),
          url: String(page.url?.() || ''),
          startedAt,
          durationMs: Math.max(0, now() - started),
          result,
          screenshotRef: shot
        };
        if (reason) entry.reason = reason;
        await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf8');
        actions.push(entry);
        if (shot) screenshots.push({step: stepNo, file: shot, url: operatorEvidenceUrl(taskId, shot)});

        const resultText = result === 'paused' ? '暂停后继续' : result === 'blocked' ? '已拦截，等待人工处理' : result === 'rejected' ? '已拒绝危险动作' : '完成';
        const evidence = {
          kind: 'operator',
          label: '步骤 ' + stepNo + ' · ' + actionLabel(step) + (step.label ? '：' + String(step.label) : '') + '（' + resultText + '）',
          detail: (entry.target ? '目标 ' + entry.target + ' · ' : '') + entry.url + (reason ? ' · ' + reason : ''),
          url: shot ? operatorEvidenceUrl(taskId, shot) : ''
        };
        await addEvidence(evidence);
        emit({
          type: 'operator_action', taskId, step: stepNo, total: plan.length,
          action: step.action, target: entry.target, result, screenshotRef: shot,
          url: entry.url, at: entry.startedAt, reason
        });
        return entry;
      };

      const danger = classifyDangerousAction(step);
      if (danger.dangerous) {
        const answer = await askHuman({
          state: 'waiting_confirmation', kind: 'confirm', confirmKind: danger.kind,
          step: stepNo, total: plan.length, target: actionTarget(step), text: danger.text,
          reason: '这一步会' + danger.reason + '，需要你确认后才执行。'
        });
        if (answer?.action === 'cancel') throw operatorAbortError();
        if (answer?.decision !== 'accept') {
          await recordStep({result: 'rejected', reason: '用户拒绝执行：' + danger.reason});
          setPhase('步骤 ' + stepNo + '：已拒绝危险动作，继续后续步骤…');
          index += 1;
          continue;
        }
        segmentStart = now();
        emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '确认后继续操作'});
      }

      setPhase('步骤 ' + stepNo + ' / ' + plan.length + '：' + actionLabel(step) + '…');
      const startedAt = new Date().toISOString();
      const started = now();
      let result = 'ok';
      let reason = '';
      let attempts = 0;
      let produced = undefined;

      while (true) {
        try {
          produced = await runOperatorStep(page, step, signal);
          break;
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw operatorAbortError();
          attempts += 1;
          if (attempts > 2) {
            throw new OperatorError('OPERATOR_STEP_FAILED', '步骤 ' + stepNo + ' 连续失败：' + String(error?.message || error).slice(0, 300), '人工接管处理页面后重试。');
          }
          const loginLike = error?.code === 'OPERATOR_LOGIN_REQUIRED';
          const answer = await askHuman({
            state: loginLike ? 'waiting_login' : 'waiting_human',
            kind: loginLike ? 'login' : 'error',
            step: stepNo, total: plan.length, target: actionTarget(step),
            reason: '步骤 ' + stepNo + ' 暂停：' + String(error?.message || error).slice(0, 300)
          });
          if (answer?.action === 'cancel') throw operatorAbortError();
          result = 'paused';
          reason = String(error?.message || error).slice(0, 300);
          segmentStart = now();
          emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '人工处理后继续操作'});
        }
      }

      // 登录/验证码/访问限制：先把这一步标成暂停并落证据，再等人处理，任务卡在等待时就能看到时间线。
      if (result === 'ok') {
        const pause = await detectOperatorPause(page);
        if (pause) {
          await recordStep({result: 'paused', reason: pause.reason, startedAt, started});
          const answer = await askHuman({
            state: pause.state, kind: pause.kind, step: stepNo, total: plan.length,
            target: actionTarget(step), reason: pause.reason
          });
          if (answer?.action === 'cancel') throw operatorAbortError();
          segmentStart = now();
          emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '人工处理后继续操作'});
          index += 1;
          continue;
        }
      }

      if (policyState.blocked) {
        const blocked = policyState.blocked;
        policyState.blocked = null;
        await recordStep({result: 'blocked', reason: blocked.reason, startedAt, started});
        const answer = await askHuman({
          state: 'waiting_human', kind: 'policy', policyKind: blocked.kind,
          step: stepNo, total: plan.length, target: actionTarget(step), reason: blocked.reason
        });
        if (answer?.action === 'cancel') throw operatorAbortError();
        segmentStart = now();
        emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '人工处理后继续操作'});
        index += 1;
        continue;
      }

      // 运行时计划：playwright 步骤返回后续步骤（例如按读到的文章列表逐篇打开）。
      // 只影响本进程内的计划，HTTP JSON 步骤仍然不可能注入函数。
      if (Array.isArray(produced) && produced.length) {
        if (plan.length + produced.length > 200) {
          throw new OperatorError('INVALID_OPERATOR_STEP', '运行时追加后步骤超过 200 步上限。');
        }
        const extra = produced.map((item, offset) => normalizeOperatorStep(item, index + 1 + offset));
        plan.splice(index + 1, 0, ...extra);
        emit({type: 'operator_running', taskId, step: stepNo, total: plan.length, phase: '继续执行运行时追加的 ' + extra.length + ' 步'});
      }

      await recordStep({result, reason, startedAt, started});
      index += 1;
    }

    emit({type: 'operator_running', taskId, step: plan.length, total: plan.length, phase: '操作计划完成'});
    return {ok: true, actions, screenshots, profileDir, actionLog: logFile};
  } finally {
    try { await context.close(); } catch { /* 关闭失败不覆盖真实结果 */ }
  }
}

// 服务层：把 operator 执行体挂到既有 source-check 任务生命周期上。
// - 任务仍是 TaskManager 的普通任务，复用任务卡/停止/证据/审计；
// - 登录、异常、时间上限与危险动作由 waiters 暂停，HTTP 接口只负责把「继续/接受/拒绝」送回执行体；
// - 服务重启后 waiters 不存在，任务会留在等待态，用户只能停止后重新发起（本票不做跨重启恢复）。
export function createOperatorService({dataDir, taskManager, launch, maxActiveMs} = {}) {
  if (!dataDir) throw new Error('来源操作服务需要 dataDir');
  if (!taskManager) throw new Error('来源操作服务需要任务管理器');
  const waiters = new Map();

  function askHuman({userId, taskId, info, emit, signal, suspendTimeout}) {
    return new Promise(resolve => {
      let settled = false;
      const waiter = {
        userId,
        taskId,
        kind: info.kind || 'human',
        confirmId: info.kind === 'confirm' ? randomUUID() : ''
      };
      const onAbort = () => done({action: 'cancel'});
      const done = value => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (waiters.get(taskId) === waiter) waiters.delete(taskId);
        resolve(value);
      };
      waiter.resolve = done;
      waiters.set(taskId, waiter);
      // 人工接管可能等很久：暂停整任务计时，由 operator 的单次 10 分钟上限兜底。
      suspendTimeout?.();
      emit({
        type: 'operator_waiting',
        taskId,
        ...info,
        confirmId: waiter.confirmId
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  // sourceId + playbook = 来源卡上的「AI 兜底」：手动触发，复用同一个 operator 任务/证据/写网关。
  // 不带 playbook 时保持既有行为（任意 URL 或显式 steps），互不影响。
  // source/title/execute 只给进程内调用方（例如公众号操作）用；HTTP 入口仍然只接受
  // sourceId|url/playbook + 普通 JSON 步骤，不能从这里注入函数。
  async function start({user, sourceId, url, steps, playbook: playbookId, source: sourceOverride = null, title: titleOverride = '', execute: executeOverride = null} = {}) {
    let fallback = null;
    if (playbookId) {
      fallback = await loadPlaybook(playbookId);
      if (!fallback) {
        return {status: 400, json: {error: '没有这个 playbook：' + String(playbookId).slice(0, 80), code: 'UNKNOWN_PLAYBOOK'}};
      }
      if (!fallback.entry.length) {
        return {status: 400, json: {error: 'playbook 没有入口地址：' + fallback.id, code: 'PLAYBOOK_WITHOUT_ENTRY'}};
      }
    }
    let source;
    if (sourceOverride) {
      if (sourceOverride.listUrl && !checkOperatorUrl(sourceOverride.listUrl).ok) {
        return {status: 400, json: {error: '来源地址不在操作员允许范围内', code: 'INVALID_URL'}};
      }
      source = sourceOverride;
    } else {
      const target = resolveSourceCheckTarget({sourceId, url});
      if (target.error) {
        // 公众号账号（wechat:<id>）不在源注册表里：用 playbook 的入口地址合成只读目标。
        // 只有带 playbook 时才这么做，普通 operator 仍按原来的错误返回。
        if (!fallback || String(url || '').trim()) {
          return {status: 400, json: {error: target.error.message, code: target.error.code}};
        }
        const entry = fallback.entry.find(item => /^https?:\/\//i.test(item));
        const synthetic = resolveSourceCheckTarget({url: entry});
        if (synthetic.error) return {status: 400, json: {error: synthetic.error.message, code: synthetic.error.code}};
        const fallbackName = String(sourceId || '').startsWith('wechat:') ? '微信公众号' : fallback.title;
        source = {...synthetic.source, id: String(sourceId || fallback.id), name: fallbackName, playbook: fallback.id, fallback: true};
      } else {
        source = target.source;
        if (fallback && target.kind === 'source' && !playbookMatchesSource(fallback, source.id)) {
          return {status: 400, json: {error: 'playbook ' + fallback.id + ' 不适用于来源 ' + source.id, code: 'PLAYBOOK_SOURCE_MISMATCH'}};
        }
        if (fallback) source = {...source, playbook: fallback.id, fallback: true};
      }
    }
    let plan = null;
    if (typeof executeOverride !== 'function') {
      try {
        plan = fallback && !(Array.isArray(steps) && steps.length)
          ? normalizeOperatorSteps(playbookSteps(fallback), {source})
          : normalizeOperatorSteps(steps, {source});
      } catch (error) {
        return {status: 400, json: {error: String(error.message || '操作步骤无效'), code: String(error.code || 'INVALID_OPERATOR_STEP')}};
      }
    }
    const label = source.school || source.name || '来源操作';
    const title = String(titleOverride || ((fallback ? AI_FALLBACK_TITLE_PREFIX : '来源操作 · ') + label)).slice(0, 200);
    const session = {
      id: randomUUID(),
      title,
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
      title,
      sourceName: fallback ? 'AI 兜底' : (executeOverride ? (source.name || '来源操作') : '来源操作'),
      onCreate: task => resolveCreated(task),
      execute: async ({task, signal, emit, addEvidence, setPhase, suspendTimeout}) => {
        let ok = false;
        try {
          const profileDir = operatorProfileDir(dataDir, user.id);
          const evidenceDir = evidenceDirFor(dataDir, user.id, task.id);
          const ask = info => askHuman({userId: user.id, taskId: task.id, info, emit, signal, suspendTimeout});
          const out = typeof executeOverride === 'function'
            ? await executeOverride({
              task, signal, emit, addEvidence, setPhase, suspendTimeout, askHuman: ask,
              source, launch, maxActiveMs, profileDir, evidenceDir
            })
            : await executeOperatorPlan({
              profileDir, evidenceDir, taskId: task.id, steps: plan, source, launch, maxActiveMs,
              signal, emit, addEvidence, setPhase, askHuman: ask
            });
          ok = true;
          return out;
        } finally {
          // 兜底同样算一次「最近手动读取」：来源卡能看到原因；采集器 last_run 不受影响。
          if (fallback) {
            try {
              recordManualRead({
                dataDir, userId: user.id, sourceId: source.id, taskId: task.id, sessionId: session.id,
                status: ok ? 'succeeded' : 'failed',
                reason: AI_FALLBACK_REASON + ' · playbook ' + fallback.id
              });
            } catch { /* 来源卡展示信息，失败不影响任务结果 */ }
          }
        }
      }
    });
    run.catch(() => {});
    const task = await created;
    return {
      status: 200,
      json: {
        ok: true,
        mode: 'operator',
        fallback: Boolean(fallback),
        playbook: fallback?.id || '',
        sourceId: source.id,
        sessionId: session.id,
        taskId: task.id,
        title,
        reason: fallback ? AI_FALLBACK_REASON : '',
        workflow: 'open'
      }
    };
  }

  // 登录/异常/时间上限后的「继续」：从停点继续，不重跑已完成步骤。
  function continueRun({userId, taskId} = {}) {
    const waiter = waiters.get(String(taskId || ''));
    if (!waiter || waiter.userId !== userId) {
      return {status: 404, json: {error: '没有等待中的来源操作任务（可能已处理或已停止）', code: 'OPERATOR_NOT_WAITING'}};
    }
    if (waiter.kind === 'confirm') {
      return {status: 409, json: {error: '当前步骤需要确认危险动作，请选择接受或拒绝', code: 'OPERATOR_CONFIRM_REQUIRED'}};
    }
    waiter.resolve({action: 'resume'});
    return {status: 200, json: {ok: true, taskId: waiter.taskId}};
  }

  // 危险动作的硬确认：接受才执行，拒绝则跳过这一步并继续计划。
  function confirm({userId, taskId, decision} = {}) {
    const waiter = waiters.get(String(taskId || ''));
    if (!waiter || waiter.userId !== userId) {
      return {status: 404, json: {error: '没有等待中的危险动作确认（可能已处理或已停止）', code: 'OPERATOR_NOT_WAITING'}};
    }
    if (waiter.kind !== 'confirm') {
      return {status: 409, json: {error: '当前任务不是危险动作确认状态', code: 'OPERATOR_NOT_CONFIRMING'}};
    }
    const value = String(decision || '');
    if (!['accept', 'reject'].includes(value)) {
      return {status: 400, json: {error: '确认选项无效', code: 'INVALID_DECISION'}};
    }
    waiter.resolve({action: 'resume', decision: value});
    return {status: 200, json: {ok: true, taskId: waiter.taskId, decision: value}};
  }

  return {start, continueRun, confirm};
}

