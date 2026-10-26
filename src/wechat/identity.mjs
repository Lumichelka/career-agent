// 公众号身份：链接归一化、biz/昵称提取、账号名归一。只做纯函数，方便测试与复用。
import {createHash} from 'node:crypto';

const WECHAT_HOST = 'mp.weixin.qq.com';
const DEMO_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'localhost']);

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// HTML 里的昵称偶尔用 JS 转义（\xE4\xB8\xAD），先还原再比较。
function decodeJsString(text) {
  return String(text || '').replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function bizOf(url) {
  try { return new URL(String(url).replace(/&amp;/g, '&')).searchParams.get('__biz') || ''; } catch { return ''; }
}

export function isWechatArticleUrl(url) {
  try { return new URL(String(url)).hostname === WECHAT_HOST; } catch { return false; }
}

export function isDemoUrl(url) {
  try { return DEMO_HOSTS.has(new URL(String(url)).hostname.toLowerCase()); } catch { return false; }
}

// 公众号文章链接只保留定位文章必需的参数，其余追踪参数、协议和 hash 全部丢弃。
// 这样同一篇文章从分享页、历史页、带 chksm 的链接进来都只算一条。
export function canonicalArticleUrl(value) {
  const raw = String(value || '').trim().replace(/&amp;/g, '&');
  if (!/^https?:\/\//i.test(raw)) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  u.protocol = 'https:';
  u.hash = '';
  if (u.hostname === WECHAT_HOST) {
    u.username = '';
    u.password = '';
    if (u.pathname === '/s' || u.pathname === '/s/') {
      const keep = ['__biz', 'mid', 'idx', 'sn'];
      const parts = [];
      for (const key of keep) {
        const value = u.searchParams.get(key);
        if (value) parts.push(key + '=' + encodeURIComponent(value).replace(/%2F/gi, '/'));
      }
      u.search = parts.length ? '?' + parts.join('&') : '';
    } else if (u.pathname.startsWith('/s/')) {
      // 短链 /s/<slug> 本身就是稳定标识；查询参数通常是分享来源。
      u.search = '';
    } else {
      // 账号主页/相册等链接保留原始查询，只去掉 hash。
      u.search = u.search;
    }
  } else {
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|share_|scene$|isappinstalled$|clicktime$)/i.test(key)) u.searchParams.delete(key);
    }
  }
  return u.href.replace(/%2F/g, '/');
}

export function articleFingerprint(url) {
  return createHash('sha1').update('wechat-article|' + canonicalArticleUrl(url)).digest('hex').slice(0, 24);
}

export function contentFingerprint(text) {
  const body = String(text || '').replace(/\s+/g, '').slice(0, 20000);
  return body.length >= 200 ? createHash('sha1').update(body).digest('hex').slice(0, 24) : '';
}

// 账号名归一：去空白/标点/常见后缀，只用于“是不是同一个账号”的判断，不改展示名。
export function accountNameKey(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[·•・\-—_|｜:：,，.。()（）【】\[\]]/g, '')
    .replace(/(微信公众号|微信公众平台|公众号|官微|官方微信)$/g, '')
    .toLowerCase();
}

export function normalizeAccountName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function parseWechatMeta(html, url = '') {
  const raw = String(html || '');
  const fromUrl = bizOf(url);
  const fromHtml = raw.match(/__biz=([A-Za-z0-9+/=%]+)/)?.[1]
    || raw.match(/\bbiz\s*[:=]\s*["']([A-Za-z0-9+/=]+)["']/i)?.[1]
    || raw.match(/data-biz=["']([A-Za-z0-9+/=]+)["']/i)?.[1]
    || '';
  let biz = '';
  try { biz = decodeURIComponent(fromUrl || fromHtml || ''); } catch { biz = fromUrl || fromHtml || ''; }

  const nickRaw = raw.match(/\bvar\s+nickname\s*=\s*["']([^"']{1,80})["']/i)?.[1]
    || raw.match(/\bnickname\s*[:=]\s*["']([^"']{1,80})["']/i)?.[1]
    || raw.match(/data-nickname=["']([^"']{1,80})["']/i)?.[1]
    || raw.match(/<strong[^>]+class=["'][^"']*profile_nickname[^"']*["'][^>]*>([\s\S]{1,120}?)<\/strong>/i)?.[1]
    || raw.match(/<span[^>]+id=["']js_name["'][^>]*>([\s\S]{1,120}?)<\/span>/i)?.[1]
    || raw.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,80})["']/i)?.[1]
    || '';
  const nickname = decodeEntities(decodeJsString(nickRaw)).replace(/<[^>]+>/g, '').trim();
  const titleRaw = raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || raw.match(/var\s+msg_title\s*=\s*["']([^"']+)["']/i)?.[1]
    || '';
  const published = raw.match(/var\s+ct\s*=\s*["'](\d{10})["']/i)?.[1]
    || raw.match(/"publish_time"\s*:\s*"?(\d{10})"?/i)?.[1]
    || '';
  return {
    biz,
    nickname: nickname.slice(0, 80),
    title: decodeEntities(titleRaw).slice(0, 200),
    publishedAt: published
  };
}
