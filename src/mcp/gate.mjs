// 统一上游闸（契约 #23 §6）：每用户 2 / 全局 8、FIFO、排队 120s → QUEUE_TIMEOUT。
// 计量单位 = 一次模型 API 调用 / 一次 MCP 出站调用 / 一次入站转发调用；
// 进程内所有用户共用一把闸，任务闸（src/server/tasks.mjs 的 TaskGate）是另一把。
import {UserFairGate} from '../lib/fair-gate.mjs';

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

// 队列逻辑与任务闸共用 UserFairGate；这里只加默认额度与上游专属错误类型。
// release 幂等；排队超时或取消都会把 waiter 从队列摘掉，绝不泄漏额度。
export class UpstreamGate extends UserFairGate {
  constructor({perUser = UPSTREAM_LIMITS.perUser, global = UPSTREAM_LIMITS.global, queueTimeoutMs = UPSTREAM_LIMITS.queueTimeoutMs, now = Date.now} = {}) {
    super({
      perUser,
      global,
      queueTimeoutMs,
      now,
      createTimeoutError: waitMs => new UpstreamQueueTimeoutError(waitMs),
      createAbortError: abortedError,
      onGrant: () => { this.granted += 1; }
    });
    this.granted = 0;
  }

  snapshot() {
    return {...this.baseSnapshot(), queueTimeoutMs: this.queueTimeoutMs};
  }

  // 包一次上游调用：拿到额度 → 执行 → 释放。调用方必须把真正的网络请求放在 fn 里。
  async run(userId, fn, {signal, timeoutMs} = {}) {
    return super.run(userId, fn, {signal, timeoutMs});
  }
}

export {abortedError as upstreamAbortedError};
