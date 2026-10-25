// 任务闸：每用户 2 个、全局 8 个并发任务，按到达顺序排队，排队超时给明确错误。
// 只做计数与排队，不认识任务本身；释放函数幂等，重复调用不会多放名额。

export function formatWait(ms) {
  const value = Math.max(0, Number(ms) || 0);
  return value >= 1000 ? Math.round(value / 1000) + ' 秒' : Math.round(value) + ' 毫秒';
}

export class QueueTimeoutError extends Error {
  constructor(waitLimitMs) {
    super('排队 ' + formatWait(waitLimitMs) + '仍未开始，请稍后再试或先停止其它任务。');
    this.name = 'QueueTimeoutError';
    this.code = 'QUEUE_TIMEOUT';
  }
}

function abortError() {
  const error = new Error('本次任务已停止。');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

export class TaskQueue {
  constructor({userLimit = 2, globalLimit = 8, waitLimitMs = 120000} = {}) {
    this.userLimit = Math.max(1, Number(userLimit) || 2);
    this.globalLimit = Math.max(1, Number(globalLimit) || 8);
    this.waitLimitMs = Math.max(0, Number(waitLimitMs) || 0);
    this.total = 0;
    this.perUser = new Map();
    this.waiters = [];
  }

  stats() {
    return {
      active: this.total,
      waiting: this.waiters.length,
      userLimit: this.userLimit,
      globalLimit: this.globalLimit,
      waitLimitMs: this.waitLimitMs
    };
  }

  activeFor(userId) {
    return this.perUser.get(String(userId || '')) || 0;
  }

  canStart(userId) {
    return this.total < this.globalLimit && this.activeFor(userId) < this.userLimit;
  }

  // 严格 FIFO：即使本用户有空位，只要前面还有人在排队，也不插队。
  // signal 中止或等待超时都会把自己从队列里摘掉，不影响后面的人。
  acquire(userId, {signal} = {}) {
    const key = String(userId || '');
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = {userId: key, resolve, reject, signal: signal || null, timer: null, onAbort: null};
      waiter.timer = setTimeout(() => {
        if (this.drop(waiter)) reject(new QueueTimeoutError(this.waitLimitMs));
      }, this.waitLimitMs);
      if (signal) {
        waiter.onAbort = () => { if (this.drop(waiter)) reject(abortError()); };
        signal.addEventListener('abort', waiter.onAbort, {once: true});
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  grant(userId) {
    this.total += 1;
    this.perUser.set(userId, this.activeFor(userId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const left = this.activeFor(userId) - 1;
      if (left > 0) this.perUser.set(userId, left); else this.perUser.delete(userId);
      this.drain();
    };
  }

  // 严格 FIFO：只看队首；队首用户已满就整条队列等，绝不让后到的越过。
  drain() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (!this.canStart(waiter.userId)) return;
      this.drop(waiter);
      waiter.resolve(this.grant(waiter.userId));
    }
  }

  drop(waiter) {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    return true;
  }
}
