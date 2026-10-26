// 公平额度闸：每用户上限 + 全局上限 + FIFO 排队 + 排队超时/取消。
// 任务闸（src/server/tasks.mjs 的 TaskGate）与上游闸（src/mcp/gate.mjs 的 UpstreamGate）
// 共用这一份队列逻辑，只在默认额度与错误类型上不同。
export class UserFairGate {
  constructor({perUser, global, queueTimeoutMs, now = Date.now, createTimeoutError = null, createAbortError = null, onGrant = null} = {}) {
    this.perUser = Math.max(1, Number(perUser) || 1);
    this.global = Math.max(1, Number(global) || 1);
    this.queueTimeoutMs = Math.max(0, Number(queueTimeoutMs ?? 120000));
    this.now = now;
    this.createTimeoutError = typeof createTimeoutError === 'function'
      ? createTimeoutError
      : waitMs => Object.assign(new Error('排队 ' + Math.round(waitMs / 1000) + ' 秒仍未轮到'), {code: 'QUEUE_TIMEOUT'});
    this.createAbortError = typeof createAbortError === 'function'
      ? createAbortError
      : () => Object.assign(new Error('本次调用已取消。'), {name: 'AbortError', code: 'CANCELLED'});
    this.onGrant = typeof onGrant === 'function' ? onGrant : null;
    this.active = 0;
    this.byUser = new Map();
    this.queue = [];
  }

  baseSnapshot() {
    return {perUser: this.perUser, global: this.global, active: this.active, queued: this.queue.length, byUser: Object.fromEntries(this.byUser)};
  }

  // release 幂等；排队超时或取消都会把 waiter 从队列摘掉，绝不泄漏额度。
  acquire(userId, {signal, timeoutMs} = {}) {
    if (!userId) throw new Error('额度闸需要用户身份');
    if (signal?.aborted) return Promise.reject(this.createAbortError());
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
      waiter.timer = setTimeout(() => settle(reject, this.createTimeoutError(waitMs)), waitMs);
      if (signal) {
        waiter.onAbort = () => settle(reject, this.createAbortError());
        signal.addEventListener('abort', waiter.onAbort, {once: true});
      }
      this.queue.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  // 包一次占用：拿到额度 → 执行 → 释放。
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
    this.onGrant?.();
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
