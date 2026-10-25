// 写网关错误到工具结果的统一映射：所有写工具共用同一套错误码与恢复建议。
export const WRITE_RECOVERY = {
  MISSING_IDEMPOTENCY_KEY: '自动写入必须带幂等键；重新发起时带上 idempotencyKey。',
  INVALID_IDEMPOTENCY_KEY: '幂等键需为 1 到 200 个字符。',
  IDEMPOTENCY_KEY_CONFLICT: '同一幂等键已用于不同参数；换一个新的幂等键再写。',
  IDEMPOTENCY_IN_PROGRESS: '同一幂等键的写入还在进行；稍后重试。',
  WRITE_LOCKED: '数据库正忙；稍后重试。',
  AUDIT_EVENT_TOO_LARGE: '单条写入内容超过 256KB；拆分或缩小这次写入。',
  WRITE_CONSTRAINT: '写入违反数据约束；修正数据后重试。',
  WRITE_FAILED: '写入失败已整体回滚；稍后重试。',
  CONFIRMATION_EXPIRED: '确认已过期，请重新发起写入并确认。',
  CONFIRMATION_MISMATCH: '确认对应的工具或参数已变化，请重新发起并确认。',
  CONFIRMATION_CONSUMED: '这次确认已经用过；重新发起写入。',
  CONFIRMATION_REJECTED: '你已经拒绝过这次写入。',
  CONFIRMATION_NOT_FOUND: '找不到这条确认记录。',
  CONFIRMATION_PENDING: '这次写入在等待你确认。'
};

export function writeFailure(error) {
  if (error instanceof Error && error.name === 'WriteError') {
    return {
      status: 'error',
      code: error.code,
      message: error.message,
      recovery: WRITE_RECOVERY[error.code] || '稍后重试；失败时不会留下半截数据。',
      writeStatus: error.status
    };
  }
  return {
    status: 'error',
    code: 'TOOL_FAILED',
    message: String(error?.message || error),
    recovery: '稍后重试；失败时不会留下半截数据。'
  };
}
