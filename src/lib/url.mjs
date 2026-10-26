// URL 归一化小工具：平台岗位去重与来源键共用，避免两个模块各写一份。
export function canonicalHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return String(raw || ''); }
}
