// 来源校对的源级能力配置与 URL 归一化：纯函数，不依赖浏览器/模型/写库/源注册表。
// 这里的口径被 src/source-check/pipeline.mjs 与 src/recruit/api.mjs 共用，
// 保证「来源卡是否开放来源校对」与「服务端能否发起」判据一致。

// source.sourceCheck 可以是布尔 true，或一个配置对象：
//   {enabled, detailPattern, participantTab, participantRequired, note}
// detailPattern 是详情链接正则的「源码」字符串（不带首尾斜杠，内部按 RegExp(pattern,'i') 编译）。
export function sourceCheckConfig(source) {
  const cfg = source?.sourceCheck;
  if (!cfg) return null;
  const enabled = cfg === true || cfg.enabled === true;
  if (!enabled) return null;
  return {
    detailPattern: typeof cfg.detailPattern === 'string' && cfg.detailPattern ? cfg.detailPattern : '',
    participantTab: typeof cfg.participantTab === 'string' && cfg.participantTab ? cfg.participantTab : '',
    participantRequired: cfg.participantRequired === true,
    note: typeof cfg.note === 'string' ? cfg.note : ''
  };
}

export function sourceCheckEnabled(source) {
  return sourceCheckConfig(source) !== null;
}

// 只接受 http/https：拒绝 javascript:/data:/file:/以及没有协议的裸地址，防止把非页面 URL 塞进浏览器。
// 默认还拒绝本机/私网/链路本地地址：来源校对由服务端浏览器发起，不能让任意 URL 变成 SSRF 跳板。
// 确需校对局域网页面时显式设置 CAREER_ALLOW_PRIVATE_SOURCE_URLS=1（或传 allowPrivate），并自行承担风险。
export function privateSourceUrlsAllowed(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env?.CAREER_ALLOW_PRIVATE_SOURCE_URLS || '').trim());
}

function privateIPv4(value) {
  const parts = String(value).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// 主机名级判断：localhost/*.local、私网 IPv4、IPv6 loopback/ULA/link-local、IPv4-mapped IPv6。
// 只做字面判断，不在此处做 DNS 解析；解析后的私网拦截由浏览器侧/网络策略另行兜底。
export function isPrivateSourceHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true; // 十进制/十六进制整数形式常被解析成 127.x/私网
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || h.startsWith('fe80:')) return true; // ULA fc00::/7 + link-local fe80::/10
  if (h.startsWith('::ffff:')) {
    const rest = h.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return privateIPv4(rest);
    const mapped = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const n = (parseInt(mapped[1], 16) << 16) | parseInt(mapped[2], 16);
      return privateIPv4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return privateIPv4(h);
  return false;
}

export function normalizeSourceCheckUrl(url, {allowPrivate = privateSourceUrlsAllowed()} = {}) {
  const raw = String(url || '').trim();
  if (!raw || raw.length > 2000) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!allowPrivate && isPrivateSourceHost(parsed.hostname)) return null;
  return parsed.href;
}

// 从列表页链接里挑「活动详情」链接：显式 pattern 优先，否则用启发式（活动文案 > 数字/详情路径 > html 后缀）。
export function selectDetailHref(links, {pattern = ''} = {}) {
  const NAV = /(login|signin|signup|register|logout|captcha|verify|passport|sso|auth|about|contact|map|help|faq|feedback|wechat|weixin|weibo)([\/?]|$)/i;
  const EXT = /\.(css|js|png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?|zip|rar|mp4|mp3)([?#]|$)/i;
  const ACTIVITY = /招聘|宣讲|双选|详情|参会|报名|查看|岗位|职位|通知|公告|专场|校园|校招|秋招|春招|宣讲会|双选会/;
  const DETAILISH = /\d|(show|detail|view|info|notice|jobfair|zhaopin|zph|position|post|career|xjh|zp)\b/i;
  const HTML = /\.s?html?(?=[?#]|$)/i;
  let re = null;
  if (pattern) {
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
  }
  const usable = [];
  for (const link of (Array.isArray(links) ? links : [])) {
    const href = String(link?.href || '').trim();
    const text = String(link?.text || '').trim();
    if (!href) continue;
    if (/^#/.test(href) || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    if (EXT.test(href) || NAV.test(href)) continue;
    if (re && re.test(href)) return href;
    let score = 0;
    if (ACTIVITY.test(text)) score += 3;
    if (DETAILISH.test(href)) score += 2;
    if (HTML.test(href)) score += 1;
    usable.push({href, score});
  }
  if (!usable.length) return '';
  let best = usable[0];
  for (const link of usable) if (link.score > best.score) best = link;
  return best.score > 0 ? best.href : usable[0].href;
}
