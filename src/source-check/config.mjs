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
export function normalizeSourceCheckUrl(url) {
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
