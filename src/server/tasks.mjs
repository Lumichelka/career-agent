// 任务生命周期：任务 id 与会话 id 分离；每用户 FIFO 闸；整任务时长上限；任务记录按用户持久化。
// 这里只管状态机、排队与记录，不执行模型：执行体由调用方注入，便于测试与后续接写网关。
import {mkdir, readFile, writeFile, readdir, rename} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UserFairGate} from '../lib/fair-gate.mjs';

export const TASK_STATES = ['queued', 'running', 'waiting_confirmation', 'blocked', 'succeeded', 'failed', 'cancelled', 'undone'];
export const ACTIVE_TASK_STATES = ['queued', 'running', 'waiting_confirmation', 'blocked'];
export const FINAL_TASK_STATES = ['succeeded', 'failed', 'cancelled', 'undone'];
// 顶栏徽标只统计「需要我现在处理」的任务；排队和终态都不进徽标。
export const BADGE_TASK_STATES = ['running', 'waiting_confirmation'];

export const TASK_STATE_LABELS = {
  queued: '排队中',
  running: '运行中',
  waiting_confirmation: '待确认',
  blocked: '受阻',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  undone: '已撤销'
};

const UUID = /^[a-f0-9-]{36}$/;

function abortedError() {
  const error = new Error('本次任务已停止。');
  error.name = 'AbortError';
  error.code = 'CANCELLED';
  return error;
}

function timeoutText(ms) {
  if (ms >= 60000 && ms % 60000 === 0) return Math.round(ms / 60000) + ' 分钟';
  if (ms >= 1000) return Math.round(ms / 1000) + ' 秒';
  return ms + ' 毫秒';
}

export class TaskQueueTimeoutError extends Error {
  constructor(waitMs = 120000) {
    super('所有执行位都在忙，已排队 ' + timeoutText(waitMs) + ' 仍未开始。可以稍后重试，或先停止其他任务。');
    this.name = 'TaskQueueTimeoutError';
    this.code = 'QUEUE_TIMEOUT';
    this.recovery = '稍后重试，或先停止其他任务。';
  }
}

// 每用户 FIFO、全局共享额度的任务闸。队列逻辑与上游闸共用 UserFairGate，只在默认值与错误类型上不同。
export class TaskGate extends UserFairGate {
  constructor({perUser = 2, global = 8, queueTimeoutMs = 120000} = {}) {
    super({perUser, global, queueTimeoutMs, createTimeoutError: waitMs => new TaskQueueTimeoutError(waitMs), createAbortError: abortedError});
  }

  snapshot() {
    return this.baseSnapshot();
  }
}

export function summarizeTasks(tasks = []) {
  const counts = {total: tasks.length, queued: 0, running: 0, waiting_confirmation: 0, blocked: 0, succeeded: 0, failed: 0, cancelled: 0, undone: 0};
  for (const task of tasks) if (counts[task.state] !== undefined) counts[task.state] += 1;
  return {tasks, counts, badge: counts.running + counts.waiting_confirmation};
}

const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

// Windows 上目标 JSON 偶尔被杀毒/索引或并发读取短暂占用，rename 会返回 EPERM/EBUSY；短暂重试即可。
async function renameTaskFile(tmp, file, attempts = 6) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(tmp, file);
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function abortRace(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

// 记录对外只保留任务本身；用户身份从认证里来，不跟随响应泄露。
export function publicTask(task) {
  const {userId, ...rest} = task;
  return {...rest, counts: {...task.counts}, evidence: [...(task.evidence || [])], drafts: (task.drafts || []).map(draft => ({...draft})), fallback: task.fallback ? {...task.fallback} : null, review: task.review ? {...task.review, issues: (task.review.issues || []).map(item => ({...item})), error: task.review.error ? {...task.review.error} : null, agent: task.review.agent ? {...task.review.agent} : null} : null};
}

export class TaskManager {
  constructor({dataDir, gate = new TaskGate(), maxDurationMs = DEFAULT_MAX_DURATION_MS, limit = 50} = {}) {
    if (!dataDir) throw new Error('TaskManager 需要 dataDir');
    this.dataDir = dataDir;
    this.gate = gate;
    this.maxDurationMs = Math.max(1, Number(maxDurationMs) || DEFAULT_MAX_DURATION_MS);
    this.limit = Math.max(1, Number(limit) || 50);
    this.runs = new Map();
    this.writes = new Map();
  }

  dirFor(userId) {
    if (!userId || /[\\/]/.test(String(userId))) throw new Error('无效的用户身份');
    return join(this.dataDir, 'users', String(userId), 'tasks');
  }

  fileFor(userId, taskId) {
    if (!UUID.test(String(taskId || ''))) throw new Error('无效的任务 id');
    return join(this.dirFor(userId), taskId + '.json');
  }

  async create({userId, sessionId, title = '', sourceName = '对话'}) {
    const at = nowIso();
    const task = {
      id: randomUUID(),
      userId,
      sessionId: String(sessionId || ''),
      title: String(title || '求职对话').slice(0, 80),
      sourceName: String(sourceName || '对话').slice(0, 80),
      state: 'queued',
      phase: '排队等待执行',
      counts: {tools: 0, steps: 0, evidence: 0, writes: 0, batches: 0, drafts: 0},
      plan: null,
      evidence: [],
      drafts: [],
      error: null,
      undo: null,
      fallback: null,
      review: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
      durationMs: 0
    };
    await this.persist(task);
    return task;
  }

  // 同一任务的并发落盘串行化，快照在入队时取，避免后写的旧状态覆盖新状态。
  persist(task) {
    const file = this.fileFor(task.userId, task.id);
    const payload = JSON.stringify(task, null, 2);
    const previous = this.writes.get(task.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(file), {recursive: true});
      const tmp = file + '.tmp';
      await writeFile(tmp, payload, 'utf8');
      await renameTaskFile(tmp, file);
    });
    this.writes.set(task.id, next);
    return next;
  }

  async read(userId, taskId) {
    try {
      const task = JSON.parse(await readFile(this.fileFor(userId, taskId), 'utf8'));
      return task && task.id === taskId ? task : null;
    } catch {
      return null;
    }
  }

  async list(userId, {sessionId} = {}) {
    let names = [];
    try { names = await readdir(this.dirFor(userId)); } catch { return []; }
    const tasks = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -5);
      if (!UUID.test(taskId)) continue;
      const task = await this.read(userId, taskId);
      if (!task) continue;
      if (sessionId && task.sessionId !== sessionId) continue;
      tasks.push(publicTask(task));
    }
    return tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, this.limit);
  }

  async summary(userId, options = {}) {
    return summarizeTasks(await this.list(userId, options));
  }

  // 停止只对自己可见；排队中的任务会被取出队列，运行中的任务收到 abort 后记为 cancelled。
  async stop(userId, taskId) {
    const run = this.runs.get(String(taskId || ''));
    if (run && run.task.userId === userId) {
      run.stop();
      return {ok: true, task: publicTask(run.task)};
    }
    const task = await this.read(userId, String(taskId || ''));
    if (!task) return {ok: false, reason: 'missing'};
    if (FINAL_TASK_STATES.includes(task.state)) return {ok: false, reason: 'finished', task: publicTask(task)};
    // 受阻任务已经没有执行体在跑：取消就是把它收尾为 cancelled，用户可自行重试。
    if (task.state === 'blocked' || task.state === 'queued') {
      task.state = 'cancelled';
      task.phase = '已取消';
      task.error = null;
      task.finishedAt = nowIso();
      task.durationMs = task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0;
      task.updatedAt = nowIso();
      await this.persist(task);
      return {ok: true, task: publicTask(task)};
    }
    return {ok: false, reason: 'missing'};
  }

  // 回退建议绑定：只有失败任务的建议能被点击一次；它记录当时算出的后端与深度。
  async checkFallback(userId, {taskId, kind} = {}) {
    const task = await this.read(userId, String(taskId || ''));
    if (!task) return {ok: false, reason: 'missing', status: 404};
    const suggestion = task.fallback;
    if (!suggestion) return {ok: false, reason: 'no-suggestion', status: 409, task: publicTask(task)};
    if (task.state !== 'failed') return {ok: false, reason: 'not-failed', status: 409, task: publicTask(task)};
    if (suggestion.consumedAt) return {ok: false, reason: 'consumed', status: 409, task: publicTask(task)};
    if (Number(suggestion.depth) >= 3) return {ok: false, reason: 'depth-limit', status: 409, task: publicTask(task)};
    if (String(kind || '') !== suggestion.kind) return {ok: false, reason: 'kind-mismatch', status: 409, task: publicTask(task)};
    return {ok: true, task: publicTask(task)};
  }

  async consumeFallback(userId, {taskId, kind} = {}) {
    const check = await this.checkFallback(userId, {taskId, kind});
    if (!check.ok) return check;
    const task = await this.read(userId, String(taskId));
    task.fallback = {...task.fallback, consumedAt: nowIso()};
    task.updatedAt = nowIso();
    await this.persist(task);
    return {ok: true, task: publicTask(task)};
  }

  // 确认接口处理完一条待确认后调用：没有剩余待确认时把任务从 waiting_confirmation 收尾。
  // finalize=false 表示这个任务还有别的待确认：只把已接受的写入条数并进任务卡，暂不收尾。
  async applyConfirmation(userId, taskId, {state = 'succeeded', phase = '确认已处理', counts = null, error = null, finalize = true} = {}) {
    const task = await this.read(userId, String(taskId || ''));
    if (!task) return null;
    if (counts) {
      // 调用方只在真实接受（非幂等重放）时传 counts，避免重复接受重复累加。
      const rows = Number(counts.rows) || 0;
      if (rows > 0) { task.counts.writes = (Number(task.counts.writes) || 0) + rows; task.counts.batches = (Number(task.counts.batches) || 0) + 1; }
    }
    if (finalize && task.state === 'waiting_confirmation') {
      task.state = TASK_STATES.includes(state) ? state : 'succeeded';
      task.phase = String(phase || '确认已处理').slice(0, 200);
      task.finishedAt = nowIso();
      task.durationMs = task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0;
      if (error && typeof error === 'object') {
        task.error = {code: String(error.code || 'CONFIRMATION_EXPIRED').slice(0, 60), message: String(error.message || '').slice(0, 500)};
        if (error.recovery) task.error.recovery = String(error.recovery).slice(0, 200);
      }
    }
    task.updatedAt = nowIso();
    await this.persist(task);
    return publicTask(task);
  }

  // 撤销接口处理完一批/整个任务后更新任务卡：全部撤销才把任务标为 undone，
  // 否则保留终态只更新撤销摘要，前端只渲染这份摘要与后端计数。
  async applyUndo(userId, taskId, {undo = null, markUndone = false} = {}) {
    const task = await this.read(userId, String(taskId || ''));
    if (!task) return null;
    if (undo && typeof undo === 'object') task.undo = {...undo};
    if (markUndone && FINAL_TASK_STATES.includes(task.state)) {
      task.state = 'undone';
      task.phase = '已撤销';
      if (task.undo) task.undo = {...task.undo, available: false, allUndone: true};
    }
    task.updatedAt = nowIso();
    await this.persist(task);
    return publicTask(task);
  }

  async setDraft(userId, {taskId, draftId, action}) {
    const target = {save: 'saved', discard: 'discarded'}[action];
    if (!target) return {ok: false, reason: 'invalid-action'};
    const task = await this.read(userId, String(taskId || ''));
    if (!task) return {ok: false, reason: 'missing'};
    const draft = (task.drafts || []).find(item => item.id === draftId);
    if (!draft) return {ok: false, reason: 'missing-draft'};
    draft.status = target;
    task.updatedAt = nowIso();
    await this.persist(task);
    return {ok: true, task: publicTask(task)};
  }

  // 一次任务 = 排队 → 执行 → 终态；执行体拿到的 emit 会被补充 task/progress/evidence 事件。
  async run({userId, sessionId, title = '', sourceName = '对话', signal, emit = () => {}, execute, describeError, describeUndo, onFailure, onCreate}) {
    if (typeof execute !== 'function') throw new Error('任务需要执行体');
    const task = await this.create({userId, sessionId, title, sourceName});
    // 调用方（如来源校对入口）需要在任务一创建就拿到 id 并立即返回，不必等执行完。
    if (typeof onCreate === 'function') { try { await onCreate(publicTask(task)); } catch { /* 通知失败不影响任务 */ } }
    const started = Date.now();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, {once: true});
    }
    const run = {task, controller, stop: () => controller.abort()};
    this.runs.set(task.id, run);
    let timedOut = false;
    let timer = null;
    let release = null;

    const baseEmit = event => { try { emit(event); } catch { /* 客户端断开不影响任务记录 */ } };
    // 敏感写入要求用户确认：任务停在 waiting_confirmation，等接受/拒绝接口处理后收尾。
    let awaitingConfirmation = false;
    const snapshot = () => ({
      taskId: task.id, state: task.state, phase: task.phase, counts: {...task.counts},
      title: task.title, sourceName: task.sourceName,
      error: task.error ? {...task.error} : null, undo: task.undo ? {...task.undo} : null,
      fallback: task.fallback ? {...task.fallback} : null
    });
    const emitTask = () => baseEmit({type: 'task', ...snapshot(), at: nowIso()});
    const emitProgress = extra => baseEmit({type: 'progress', taskId: task.id, state: task.state, phase: task.phase, counts: {...task.counts}, ...extra, at: nowIso()});
    const touch = () => { task.updatedAt = nowIso(); };

    // 事件触发的状态写入要排队收尾：先落 waiting_confirmation，再落 succeeded，事件顺序才稳定。
    const stateWrites = [];
    const setState = async (state, extra = {}) => {
      task.state = state;
      if (extra.phase) task.phase = String(extra.phase).slice(0, 200);
      touch();
      // 先取快照再落盘：后一个状态不能把前一个事件的 state 改写掉。
      const payload = snapshot();
      await this.persist(task);
      baseEmit({type: 'task', ...payload, at: nowIso()});
    };
    const deferState = (...args) => {
      const write = setState(...args);
      stateWrites.push(write.catch(() => {}));
      return write;
    };
    const setPhase = text => {
      const phase = String(text || '').trim().slice(0, 200);
      if (!phase || task.phase === phase) return;
      task.phase = phase;
      touch();
      emitProgress();
    };
    const addEvidence = async evidence => {
      if (!evidence) return;
      const entry = {
        id: randomUUID(),
        kind: String(evidence.kind || 'tool').slice(0, 40),
        label: String(evidence.label || '').slice(0, 200),
        detail: evidence.detail ? String(evidence.detail).slice(0, 2000) : '',
        url: typeof evidence.url === 'string' ? evidence.url.slice(0, 500) : '',
        at: nowIso()
      };
      if (!entry.label) return;
      task.evidence.push(entry);
      task.evidence = task.evidence.slice(-20);
      task.counts.evidence = task.evidence.length;
      touch();
      await this.persist(task);
      baseEmit({type: 'evidence', taskId: task.id, evidence: entry, counts: {...task.counts}, at: entry.at});
      emitProgress();
    };
    const addDraft = draft => {
      if (!draft) return null;
      const entry = {
        id: randomUUID(),
        title: String(draft.title || '求职文稿').slice(0, 80),
        content: String(draft.content || '').slice(0, 20000),
        status: 'draft',
        createdAt: nowIso()
      };
      task.drafts.push(entry);
      task.counts.drafts = task.drafts.length;
      touch();
      emitProgress();
      return entry;
    };

    // 已存在的 status/plan/tool/error/heartbeat 语义不变，只在其上补任务状态。
    const forward = event => {
      if (!event || typeof event !== 'object') return;
      baseEmit(event);
      try {
        switch (event.type) {
          case 'status':
            setPhase(event.text);
            break;
          case 'plan': {
            const steps = Array.isArray(event.plan?.steps) ? event.plan.steps : [];
            task.counts.steps = steps.length;
            task.plan = {goal: String(event.plan?.goal || '').slice(0, 200), steps: steps.slice(0, 5).map(step => String(step).slice(0, 200))};
            touch();
            emitProgress();
            break;
          }
          case 'tool':
            task.counts.tools += 1;
            if (event.text) setPhase(event.text);
            void addEvidence({kind: 'tool', label: event.text || event.toolType || '工具调用', detail: event.toolType || ''});
            break;
          case 'tool_progress':
            emitProgress({progress: event.progress, total: event.total, message: event.message});
            break;
          case 'review': {
            // 复核只存问题列表与失败码，不存调用记录（调用记录只挂助手消息）。
            const source = event.review && typeof event.review === 'object' ? event.review : null;
            if (source) {
              task.review = {
                status: ['issues', 'clean', 'unparsed', 'unavailable'].includes(source.status) ? source.status : 'unavailable',
                count: Math.max(0, Number(source.count) || 0),
                issues: (Array.isArray(source.issues) ? source.issues : []).slice(0, 100).map(item => ({
                  row: String(item?.row || '').slice(0, 120),
                  field: String(item?.field || '').slice(0, 120),
                  issue: String(item?.issue || '').slice(0, 500),
                  severity: String(item?.severity || '').slice(0, 20)
                })),
                raw: String(source.raw || '').slice(0, 4000),
                agentLeg: source.agentLeg === 'passed' ? 'passed' : 'failed',
                attempted: source.attempted === true,
                agent: source.agent ? {id: String(source.agent.id || ''), name: String(source.agent.name || '').slice(0, 80)} : null,
                tool: String(source.tool || '').slice(0, 120),
                error: source.error ? {
                  code: String(source.error.code || 'REVIEW_FAILED').slice(0, 60),
                  message: String(source.error.message || '').slice(0, 500),
                  recovery: String(source.error.recovery || '').slice(0, 300)
                } : null,
                at: String(source.at || nowIso())
              };
              touch();
              void this.persist(task);
              emitProgress();
            }
            break;
          }
          case 'writes': {
            // 一次批量写 = 一个批次；重放的幂等结果不发 writes 事件，因此不会被算成新写入。
            const rows = Number(event.counts?.rows ?? event.counts?.total ?? 0);
            if (Number.isFinite(rows) && rows > 0) task.counts.writes = (Number(task.counts.writes) || 0) + rows;
            if (event.batchId) task.counts.batches = (Number(task.counts.batches) || 0) + 1;
            touch();
            emitProgress();
            break;
          }
          case 'evidence':
            if (event.evidence) void addEvidence(event.evidence);
            break;
          case 'platform_required':
            void deferState('waiting_confirmation', {phase: '等待你完成登录或确认'});
            break;
          // 首次出网确认：任务是 waiting_confirmation（徽标计入），等用户在对话页选完再继续本轮。
          case 'external_confirm_required':
            void deferState('waiting_confirmation', {phase: '等待出网确认'});
            break;
          case 'external_confirm_resolved':
            if (task.state === 'waiting_confirmation') void deferState('running', {phase: '继续执行'});
            break;
          case 'mrtr_elicit_required':
            // 外部 Agent 的 MRTR 表单：任务停在待确认，用户提交/拒绝/超时后继续。
            void deferState('waiting_confirmation', {phase: '等待填写外部 Agent 表单'});
            break;
          case 'mrtr_elicit_resolved':
            if (task.state === 'waiting_confirmation') void deferState('running', {phase: '继续执行'});
            break;
          case 'platform_resolved':
          case 'confirm_resolved':
            if (task.state === 'waiting_confirmation') void deferState('running', {phase: '继续执行'});
            break;
          case 'confirm_required':
            if (event.confirmId) awaitingConfirmation = true;
            void deferState('waiting_confirmation', {phase: '等待确认'});
            break;
          case 'blocked': {
            const reason = String(event.reason || event.message || '任务受阻').slice(0, 200);
            task.error = {code: String(event.code || 'BLOCKED').slice(0, 60), message: reason.slice(0, 500)};
            if (event.recovery) task.error.recovery = String(event.recovery).slice(0, 200);
            void deferState('blocked', {phase: reason});
            break;
          }
          case 'task_state':
            if (TASK_STATES.includes(event.state)) void deferState(event.state, {phase: event.phase});
            break;
          default:
            break;
        }
      } catch { /* 任务记录不能反过来弄断执行 */ }
    };

    try {
      await setState('queued', {phase: '排队等待执行'});
      release = await this.gate.acquire(userId, {signal: controller.signal});
      if (controller.signal.aborted) throw abortedError();
      task.startedAt = nowIso();
      await setState('running', {phase: '正在理解你的需求'});
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.maxDurationMs);

      const execution = Promise.resolve().then(() => execute({
        task: publicTask(task),
        signal: controller.signal,
        emit: forward,
        addDraft,
        addEvidence,
        setPhase,
        setState
      }));
      execution.catch(() => {});
      const result = await Promise.race([execution, abortRace(controller.signal)]);
      // 待确认任务要先落 waiting_confirmation 的事件，再决定是否收尾，事件顺序才稳定。
      if (awaitingConfirmation) await Promise.allSettled(stateWrites);

      if (awaitingConfirmation && task.state === 'waiting_confirmation') {
        // 执行体已经交付，但敏感写入还等用户确认：保持待确认，收尾交给确认接口。
        task.phase = '等待确认';
        task.durationMs = Date.now() - started;
        touch();
        await this.persist(task);
        emitTask();
        return {task: publicTask(task), result, error: null};
      }
      // blocked 是活动态（等用户取消/处理），不能被任务收尾改成 succeeded。
      if (task.state === 'running' || task.state === 'waiting_confirmation') {
        task.state = 'succeeded';
        task.phase = '任务完成';
        task.undo = {available: false, summary: '本次任务没有自动写入记录。', undone: 0, conflicts: 0};
      }
      task.finishedAt = nowIso();
      task.durationMs = Date.now() - started;
      touch();
      // 撤销摘要来自写入审计：任务卡据此显示「可撤销 N 条」与入口。
      if (typeof describeUndo === 'function') {
        try {
          const described = await describeUndo({task: publicTask(task)});
          if (described && typeof described === 'object') task.undo = described;
        } catch { /* 摘要算不出来不影响任务收尾 */ }
      }
      await this.persist(task);
      emitTask();
      return {task: publicTask(task), result, error: null};
    } catch (error) {
      task.finishedAt = nowIso();
      task.durationMs = Date.now() - started;
      if (timedOut) {
        task.state = 'failed';
        task.phase = '已停止';
        task.error = {
          code: 'TASK_TIMEOUT',
          message: '任务超过 ' + timeoutText(this.maxDurationMs) + '上限，已停止。',
          recovery: '缩小任务范围后重试。'
        };
      } else if (controller.signal.aborted) {
        task.state = 'cancelled';
        task.phase = '已取消';
        task.error = null;
      } else {
        task.state = 'failed';
        task.phase = '失败';
        let message = String(error?.message || '任务失败');
        if (typeof describeError === 'function') {
          try { message = String(describeError(error) || message); } catch { /* 保留原始错误 */ }
        }
        task.error = {code: error?.code || 'TASK_FAILED', message: message.slice(0, 500)};
        if (error?.recovery) task.error.recovery = String(error.recovery).slice(0, 200);
      }
      // 回退建议由调用方按「锁定 / 副作用 / 连续失败」算出，绑定在这次失败的任务上；
      // 建议事件先于 error 发出，前端读到错误时已经知道可以「换 X 重试」。
      if (typeof onFailure === 'function' && task.state === 'failed') {
        try {
          const suggestion = await onFailure({task: publicTask(task), error});
          if (suggestion && suggestion.kind) task.fallback = {...suggestion, taskId: task.id, createdAt: nowIso()};
        } catch { /* 建议算不出来不影响报错 */ }
      }
      touch();
      if (typeof describeUndo === 'function') {
        try {
          const described = await describeUndo({task: publicTask(task)});
          if (described && typeof described === 'object') task.undo = described;
        } catch { /* 摘要算不出来不影响失败收尾 */ }
      }
      await this.persist(task);
      emitTask();
      if (task.fallback) baseEmit({type: 'fallback_suggested', taskId: task.id, ...task.fallback, at: nowIso()});
      if (task.error) baseEmit({type: 'error', taskId: task.id, text: task.error.message, code: task.error.code, recovery: task.error.recovery || '', at: nowIso()});
      const finalError = task.error ? Object.assign(new Error(task.error.message), task.error) : error;
      return {task: publicTask(task), result: null, error: finalError};
    } finally {
      if (timer) clearTimeout(timer);
      if (release) release();
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this.runs.delete(task.id);
      await this.persist(task).catch(() => {});
      const lastWrite = this.writes.get(task.id);
      if (lastWrite) await lastWrite.catch(() => {});
      this.writes.delete(task.id);
    }
  }
}