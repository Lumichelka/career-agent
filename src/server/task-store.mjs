// 对话任务的状态与载体：一个任务一张卡，状态只沿状态机前进；事件、证据、草稿都挂在任务上。
// 持久化到每个用户自己的数据目录（tasks.json），进程内以内存为准，写盘按需合并。
import {readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const TASK_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNDONE: 'undone'
});

export const TERMINAL_STATES = new Set([TASK_STATES.SUCCEEDED, TASK_STATES.FAILED, TASK_STATES.CANCELLED, TASK_STATES.UNDONE]);

const TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['waiting_confirmation', 'succeeded', 'failed', 'cancelled', 'undone']),
  waiting_confirmation: new Set(['running', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  undone: new Set()
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) === true;
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function text(value, max) {
  return String(value ?? '').slice(0, max);
}

function normalizeTask(raw) {
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString();
  return {
    id: String(raw.id),
    sessionId: String(raw.sessionId || ''),
    title: text(raw.title || '未命名任务', 80),
    backend: text(raw.backend || '', 120),
    sourceName: text(raw.sourceName || '', 60),
    state: TASK_STATES[String(raw.state || '').toUpperCase()] || (TRANSITIONS[raw.state] ? raw.state : 'failed'),
    createdAt,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
    progress: {
      percent: normalizePercent(raw.progress?.percent),
      text: text(raw.progress?.text || '', 200),
      updatedAt: raw.progress?.updatedAt || createdAt
    },
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(item => item && typeof item === 'object') : [],
    draft: raw.draft && typeof raw.draft === 'object' ? raw.draft : null,
    error: raw.error && typeof raw.error === 'object' ? raw.error : null,
    stopReason: text(raw.stopReason || '', 40),
    events: Array.isArray(raw.events) ? raw.events.filter(event => event && typeof event === 'object') : [],
    seq: Math.max(0, Number(raw.seq) || 0)
  };
}

export function taskTiming(task) {
  const created = Date.parse(task.createdAt) || 0;
  const started = Date.parse(task.startedAt) || 0;
  const finished = Date.parse(task.finishedAt) || 0;
  return {
    queuedMs: started ? Math.max(0, started - created) : 0,
    durationMs: started && finished ? Math.max(0, finished - started) : 0
  };
}

// 给浏览器和事件流用的任务快照：不带完整事件历史，避免每个事件都塞一遍。
export function publicTask(task) {
  const {events, seq, ...rest} = task;
  return {...rest, eventCount: events.length, ...taskTiming(task)};
}

export class TaskStore {
  constructor(dir, {maxTasks = 50, maxEvents = 200, maxEvidence = 20, now = () => new Date().toISOString()} = {}) {
    this.file = join(dir, 'tasks.json');
    this.maxTasks = maxTasks;
    this.maxEvents = maxEvents;
    this.maxEvidence = maxEvidence;
    this.now = now;
    this.tasks = [];
    this.dirty = false;
    this.writing = null;
    this.persistError = '';
    this.loadError = '';
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.tasks)) this.tasks = raw.tasks.filter(task => task && typeof task.id === 'string').map(normalizeTask);
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = error.message;
    }
    this.tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    this.recoverInterrupted();
    return this;
  }

  // 重启后没有进程在跑，残留的排队/运行中任务标失败，而不是永远挂着「运行中」。
  recoverInterrupted() {
    let changed = false;
    for (const task of this.tasks) {
      if (TERMINAL_STATES.has(task.state)) continue;
      task.state = TASK_STATES.FAILED;
      task.finishedAt = this.now();
      task.stopReason = 'restart';
      this.record(task, {type: 'error', text: '服务重启时任务还未结束，已标记为失败。', code: 'TASK_INTERRUPTED', recovery: '重新发送这条消息即可重试。'});
      this.record(task, {type: 'task_state', state: TASK_STATES.FAILED, reason: 'restart'});
      changed = true;
    }
    if (changed) this.persist();
  }

  create({sessionId, title, backend = '', sourceName = ''}) {
    const createdAt = this.now();
    const task = normalizeTask({
      id: randomUUID(),
      sessionId,
      title,
      backend,
      sourceName,
      state: TASK_STATES.QUEUED,
      createdAt,
      progress: {percent: 0, text: '排队中', updatedAt: createdAt},
      evidence: [],
      draft: null,
      error: null,
      events: [],
      seq: 0
    });
    this.tasks.unshift(task);
    if (this.tasks.length > this.maxTasks) this.tasks.length = this.maxTasks;
    this.record(task, {type: 'task_state', state: TASK_STATES.QUEUED, reason: ''});
    return task;
  }

  find(id) {
    return this.tasks.find(task => task.id === id) || null;
  }

  list({sessionId = ''} = {}) {
    return this.tasks.filter(task => !sessionId || task.sessionId === sessionId).map(publicTask);
  }

  snapshot(task) {
    return publicTask(task);
  }

  transition(task, state, {reason = ''} = {}) {
    if (!canTransition(task.state, state)) throw new Error('任务状态不能从 ' + task.state + ' 变成 ' + state);
    if (state === TASK_STATES.RUNNING && !task.startedAt) task.startedAt = this.now();
    if (TERMINAL_STATES.has(state)) task.finishedAt = task.finishedAt || this.now();
    if (reason) task.stopReason = text(reason, 40);
    task.state = state;
    return this.record(task, {type: 'task_state', state, reason});
  }

  // 所有事件走这里：分配序号、落状态副作用、裁剪历史并安排写盘。
  record(task, event) {
    const stored = {...event, seq: task.seq + 1, at: this.now()};
    task.seq = stored.seq;
    task.events.push(stored);
    if (task.events.length > this.maxEvents) task.events.splice(0, task.events.length - this.maxEvents);
    if (stored.type === 'progress') {
      task.progress = {
        percent: Math.max(task.progress?.percent || 0, normalizePercent(stored.percent)),
        text: text(stored.text || '', 200),
        updatedAt: stored.at
      };
    } else if (stored.type === 'evidence') {
      const item = {...stored.evidence, id: randomUUID(), at: stored.at};
      task.evidence = [...task.evidence, item].slice(-this.maxEvidence);
    } else if (stored.type === 'draft') {
      task.draft = {...stored.draft, at: stored.at};
    } else if (stored.type === 'error') {
      task.error = {
        code: text(stored.code || 'FAILED', 40),
        message: text(stored.text || stored.message || '', 500),
        recovery: text(stored.recovery || '', 300),
        at: stored.at
      };
    }
    this.persist();
    return stored;
  }

  persist() {
    this.dirty = true;
    if (this.writing) return;
    this.writing = this.drainWrites().finally(() => { this.writing = null; });
  }

  async drainWrites() {
    while (this.dirty) {
      this.dirty = false;
      const payload = JSON.stringify({version: 1, tasks: this.tasks});
      try {
        await writeFile(this.file + '.tmp', payload, 'utf8');
        await rename(this.file + '.tmp', this.file);
      } catch (error) {
        if (this.persistError !== error.message) {
          this.persistError = error.message;
          console.error('任务记录写入失败：' + error.message);
        }
      }
    }
  }

  async flush() {
    if (this.writing) await this.writing;
    if (this.dirty) {
      this.persist();
      if (this.writing) await this.writing;
    }
  }
}
