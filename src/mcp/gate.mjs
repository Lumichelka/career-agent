// 统一上游闸（契约 #23 §6）：每用户 2 / 全局 8、FIFO、排队 120s → QUEUE_TIMEOUT。
// 计量单位 = 一次模型 API 调用 / 一次 MCP 出站调用 / 一次入站转发调用；
// 进程内所有用户共用一把闸，任务闸（src/server/tasks.mjs 的 TaskGate）是另一把。
export const UPSTREAM_LIMITS = {perUser: 2, global: 8, queueTimeoutMs: 120000};

function abortedError() {
  const error = new Error('本次上游调用已取消。');
  error.name = 'AbortError';
  error.code = 'CANCELLED';
  return error;
}

export class UpstreamQueueTimeoutError extends Error {
  constructor(waitMs = UPSTREAM_LIMITS.queueTimeoutMs) {
    super('上游并发已满，已排队 ' + Math.max(0, Math.round(Number(waitMs) / 1000)) + ' 秒仍未轮到。可以稍后重试，或减少同时进行的任务。');
    this.name = 'UpstreamQueueTimeoutError';
    this.code = 'QUEUE_TIMEOUT';
    this.recovery = '稍后重试，或减少同时进行的模型调用 / 外部 Agent 调用。';
  }
}

// release 幂等；排队超时或取消都会把 waiter 从队列摘掉，绝不泄漏额度。
export class UpstreamGate {
  constructor({perUser = UPSTREAM_LIMITS.perUser, global = UPSTREAM_LIMITS.global, queueTimeoutMs = UPSTREAM_LIMITS.queueTimeoutMs, now = Date.now} = {}) {
    this.perUser = Math.max(1, Number(perUser) || UPSTREAM_LIMITS.perUser);
    this.global = Math.max(1, Number(global) || UPSTREAM_LIMITS.global);
    this.queueTimeoutMs = Math.max(0, Number(queueTimeoutMs ?? UPSTREAM_LIMITS.queueTimeoutMs));
    this.now = now;
    this.active = 0;
    this.byUser = new Map();
    this.queue = [];
    this.granted = 0;
  }

  snapshot() {
    return {
      perUser: this.perUser,
      global: this.global,
      queueTimeoutMs: this.queueTimeoutMs,
      active: this.active,
      queued: this.queue.length,
      byUser: Object.fromEntries(this.byUser)
    };
  }

  acquire(userId, {signal, timeoutMs} = {}) {
    if (!userId) throw new Error('上游闸需要用户身份');
    if (signal?.aborted) return Promise.reject(abortedError());
    if (this.#hasCapacity(userId)) return Promise.resolve(this.#grant(userId));
    const waitMs = timeoutMs === undefined ? this.queueTimeoutMs : Math.max(0, Number(timeoutMs) || 0);
    return new Promise((resolve, reject) => {
      const waiter = {userId, resolve, reject, timer: null, onAbort: null, queuedAt: this.now()};
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
      waiter.timer = setTimeout(() => settle(reject, new UpstreamQueueTimeoutError(waitMs)), waitMs);
      if (signal) {
        waiter.onAbort = () => settle(reject, abortedError());
        signal.addEventListener('abort', waiter.onAbort, {once: true});
      }
      this.queue.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  // 包一次上游调用：拿到额度 → 执行 → 释放。调用方必须把真正的网络请求放在 fn 里。
  async run(userId, fn, {signal, timeoutMs} = {}) {
    const release = await this.acquire(userId, {signal, timeoutMs});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #hasCapacity(userId) {
    return this.active < this.global && (this.byUser.get(userId) || 0) < this.perUser;
  }

  #grant(userId) {
    this.active += 1;
    this.granted += 1;
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

  // 每个用户自己的排队顺序不变；被额度挡住的 waiter 直接跳过，避免一个用户堵住全局。
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

export {abortedError as upstreamAbortedError};
