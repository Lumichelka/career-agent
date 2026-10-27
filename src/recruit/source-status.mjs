// 来源状态词表：采集器、存储层与来源表共用，避免同一状态在各处各说各话。
export const SOURCE_STATUSES = Object.freeze([
  'connected',
  'list_only',
  'needs_login',
  'blocked_robots',
  'network_error',
  'empty',
  'disabled'
]);

export const SOURCE_STATUS_LABELS = Object.freeze({
  connected: '已连通',
  list_only: '仅列表',
  needs_login: '需登录',
  blocked_robots: '被站点拦截',
  network_error: '网络或解析失败',
  empty: '暂无活动',
  disabled: '未接入'
});

// 旧库/旧调用里出现过的写法，读出来时统一成规格词表；写回时也只写新词。
const LEGACY_STATUSES = Object.freeze({
  ok: 'connected',
  success: 'connected',
  disallowed: 'blocked_robots',
  blocked: 'blocked_robots',
  login_required: 'needs_login',
  error: 'network_error',
  failed: 'network_error',
  timeout: 'network_error'
});

export function normalizeSourceStatus(status) {
  const value = String(status || '').trim();
  if (!value) return '';
  if (Object.prototype.hasOwnProperty.call(SOURCE_STATUS_LABELS, value)) return value;
  return LEGACY_STATUSES[value] || 'network_error';
}

export function sourceStatusLabel(status) {
  const value = normalizeSourceStatus(status);
  return SOURCE_STATUS_LABELS[value] || '待采集';
}

export function isSuccessfulSourceStatus(status) {
  const value = normalizeSourceStatus(status);
  return value === 'connected' || value === 'empty' || value === 'list_only';
}

// 批量采集汇总里的“源失败”：需要人工处理的登录型停点也算失败；disabled 不参与采集。
export function isFailedSourceStatus(status) {
  const value = normalizeSourceStatus(status);
  return value === 'network_error' || value === 'blocked_robots' || value === 'needs_login';
}

// 来源表 badge 的三档颜色：已连通 / 仅提示（空、未接入、需登录）/ 错误。
export function sourceStatusTone(status) {
  const value = normalizeSourceStatus(status);
  if (value === 'connected') return 'ok';
  if (value === 'blocked_robots' || value === 'network_error') return 'err';
  return 'off';
}

// HTTP/浏览器抓取失败原因 → 规格状态。
export function sourceStatusFromFetchReason(reason) {
  const value = String(reason || '');
  if (value === 'robots_disallowed' || value === 'blocked') return 'blocked_robots';
  return 'network_error';
}

// 适配器抛出的 SourceError.kind → 规格状态。
export function sourceStatusFromErrorKind(kind) {
  const value = String(kind || '');
  if (value === 'login_required' || value === 'login') return 'needs_login';
  if (value === 'blocked') return 'blocked_robots';
  if (value === 'empty') return 'empty';
  return 'network_error';
}
