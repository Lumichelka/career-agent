export function publicUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

export function requireBridge(config) {
  const base = process.env.CAREER_BRIDGE_URL;
  const token = config?.bridgeToken || process.env.CAREER_BRIDGE_TOKEN;
  if (!base || !token) throw new Error('本机平台桥接未就绪');
  return {base, token};
}
