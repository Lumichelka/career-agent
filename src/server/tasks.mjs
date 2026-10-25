// 任务生命周期：任务 id 与会话 id 分离；每用户 FIFO 闸；整任务时长上限；任务记录按用户持久化。
// 这里只管状态机、排队与记录，不执行模型：执行体由调用方注入，便于测试与后续接写网关。
import {mkdir, readFile, writeFile, readdir, rename} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

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

// 每用户 FIFO、全局共享额度的任务闸。release 幂等；排队超时/取消都会从队列里摘掉。
export class TaskGate {
  constructor({perUser = 2, global = 8, queueTimeoutMs = 120000} = {}) {
    this.perUser = Math.max(1, Number(perUser) || 2);
    this.global = Math.max(1, Number(global) || 8);
    this.queueTimeoutMs = Math.max(0, Number(queueTimeoutMs ?? 120000));
    this.active = 0;
    this.byUser = new Map();
    this.queue = [];
  }

  snapshot() {
    return {perUser: this.perUser, global: this.global, active: this.active, queued: this.queue.length, byUser: Object.fromEntries(this.byUser)};
  }

  acquire(userId, {signal} = {}) {
    if (!userId) throw new Error('任务闸需要用户身份');
    if (signal?.aborted) return Promise.reject(abortedError());
    if (this.#hasCapacity(userId)) return Promise.resolve(this.#grant(userId));
    return new Promise((resolve, reject) => {
      const waiter = {userId, resolve, reject, timer: null, onAbort: null};
      waiter.cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
      };
      const settle = (fn, value) => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        waiter.cleanup();
        fn(value);
        return true;
      };
      waiter.timer = setTimeout(() => settle(reject, new TaskQueueTimeoutError(this.queueTimeoutMs)), this.queueTimeoutMs);
      if (signal) {
        waiter.onAbort = () => settle(reject, abortedError());
        signal.addEventListener('abort', waiter.onAbort, {once: true});
      }
      this.queue.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  #hasCapacity(userId) {
    return this.active < this.global && (this.byUser.get(userId) || 0) < this.perUser;
  }

  #grant(userId) {
    this.active += 1;
    this.byUser.set(userId, (this.byUser.get(userId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const left = (this.byUser.get(userId) || 1) - 1;
      if (left <= 0) this.byUser.delete(userId);
      else this.byUser.set(userId, left);
      this.#pump();
    };
  }

  #pump() {
    while (this.active < this.global) {
      const index = this.queue.findIndex(waiter => (this.byUser.get(waiter.userId) || 0) < this.perUser);
      if (index < 0) return;
      const [waiter] = this.queue.splice(index, 1);
      waiter.cleanup();
      waiter.resolve(this.#grant(waiter.userId));
    }
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
  return {...rest, counts: {...task.counts}, evidence: [...(task.evidence || [])], drafts: (task.drafts || []).map(draft => ({...draft})), fallback: task.fallback ? {...task.fallback} : null};
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
      // Windows 上杀毒/索引偶尔会短暂占用目标文件，rename 报 EPERM/EBUSY；重试几次再判定失败。
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(tmp, file); return; }
        catch (error) {
          if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
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
  async run({userId, sessionId, title = '', sourceName = '对话', signal, emit = () => {}, execute, describeError, onFailure}) {
    if (typeof execute !== 'function') throw new Error('任务需要执行体');
    const task = await this.create({userId, sessionId, title, sourceName});
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
    const snapshot = () => ({
      taskId: task.id, state: task.state, phase: task.phase, counts: {...task.counts},
      title: task.title, sourceName: task.sourceName,
      error: task.error ? {...task.error} : null, undo: task.undo ? {...task.undo} : null,
      fallback: task.fallback ? {...task.fallback} : null
    });
    const emitTask = () => baseEmit({type: 'task', ...snapshot(), at: nowIso()});
    const emitProgress = extra => baseEmit({type: 'progress', taskId: task.id, state: task.state, phase: task.phase, counts: {...task.counts}, ...extra, at: nowIso()});
    const touch = () => { task.updatedAt = nowIso(); };

    const setState = async (state, extra = {}) => {
      task.state = state;
      if (extra.phase) task.phase = String(extra.phase).slice(0, 200);
      touch();
      // 先取快照再落盘：后一个状态不能把前一个事件的 state 改写掉。
      const payload = snapshot();
      await this.persist(task);
      baseEmit({type: 'task', ...payload, at: nowIso()});
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
            void setState('waiting_confirmation', {phase: '等待你完成登录或确认'});
            break;
          case 'platform_resolved':
          case 'confirm_resolved':
            if (task.state === 'waiting_confirmation') void setState('running', {phase: '继续执行'});
            break;
          case 'confirm_required':
            void setState('waiting_confirmation', {phase: '等待确认'});
            break;
          case 'blocked':
            void setState('blocked', {phase: String(event.reason || '任务受阻')});
            break;
          case 'task_state':
            if (TASK_STATES.includes(event.state)) void setState(event.state, {phase: event.phase});
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

      if (task.state === 'running' || task.state === 'waiting_confirmation' || task.state === 'blocked') {
        task.state = 'succeeded';
        task.phase = '任务完成';
        task.undo = {available: false, summary: '本次任务没有自动写入记录。', undone: 0, conflicts: 0};
      }
      task.finishedAt = nowIso();
      task.durationMs = Date.now() - started;
      touch();
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
