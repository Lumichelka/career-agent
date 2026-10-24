// 手动 / 公众号导入：解析用户主动提供的链接或正文，产出草稿；保存由用户确认。
import {fetchText} from './fetch.mjs';
import {guessKind, guessCompany, normalizeCity} from './sources/index.mjs';

const pad = n => String(n).padStart(2, '0');

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

export function htmlToPlainText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseArticleHtml(html) {
  const raw = String(html || '');
  const og = raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const h1 = raw.match(/<h1[^>]*class=["'][^"']*rich_media_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
    || raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = decodeEntities((og?.[1] || htmlToPlainText(h1?.[1] || '') || '').trim()).slice(0, 120);
  const ct = raw.match(/var\s+ct\s*=\s*["'](\d{10})["']/i)?.[1]
    || raw.match(/"publish_time"\s*:\s*"([^"]+)"/i)?.[1]
    || raw.match(/property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return {title, text: htmlToPlainText(raw), publishedAt: ct || ''};
}

export function extractDraft({text, title = '', url = '', kind = ''}) {
  const body = String(text || '').replace(/\r\n/g, '\n');
  const warnings = [];
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  const heading = (title || lines[0] || '').slice(0, 120);

  let date = '';
  const m1 = body.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})/);
  const m2 = body.match(/(\d{1,2})月(\d{1,2})日/);
  if (m1) date = `${m1[1]}-${pad(m1[2])}-${pad(m1[3])}`;
  else if (m2) date = `${new Date().getFullYear()}-${pad(m2[1])}-${pad(m2[2])}`;
  else warnings.push('未识别到日期，请手动填写');

  let hh = '', mm = '', timeFound = false;
  const t1 = body.match(/(\d{1,2})[:：](\d{2})/);
  const t2 = body.match(/(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分?)?/);
  if (t1) { hh = pad(t1[1]); mm = t1[2]; timeFound = true; }
  else if (t2) { hh = pad(t2[1]); mm = pad(t2[2] || 0); timeFound = true; }
  if (!timeFound) { hh = '09'; mm = '00'; warnings.push('未识别到时间，默认 09:00，请确认'); }

  let venue = '';
  const v1 = body.match(/(?:活动|举办|宣讲|招聘)?地点[：:]\s*([^\n，。；]{2,60})/);
  const v2 = body.match(/在\s*([^\n，。；]{2,40})\s*(?:举行|举办)/);
  if (v1) venue = v1[1].trim();
  else if (v2) venue = v2[1].trim();
  if (!venue) warnings.push('未识别到地点，请手动填写');

  let applyMode = '';
  if (/网申|网上申请|在线投递/.test(body)) applyMode = '网申';
  else if (/邮箱|投递至|发送简历/.test(body)) applyMode = '邮箱投递';
  else if (/现场投递|现场收简历/.test(body)) applyMode = '现场投递';

  const draftKind = kind || (/就业指导|讲座|培训|简历门诊|生涯规划/.test(heading + ' ' + body) ? '就业指导' : guessKind(heading + ' ' + body, '其他'));
  const company = guessCompany(heading) || (heading.match(/([\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}(?:公司|集团|银行|事务所|研究院|中心))/)?.[1] || '');
  const city = normalizeCity(venue || '', '');

  return {
    title: heading,
    company: company.slice(0, 120),
    kind: draftKind,
    city,
    venue: venue.slice(0, 120),
    startAt: date ? `${date}T${hh}:${mm}:00+08:00` : '',
    endAt: '',
    applyMode,
    sourceUrl: url,
    notes: ['手动导入', ...warnings].join('；'),
    warnings
  };
}

export async function parseManualInput({url = '', text = '', kind = ''} = {}) {
  const link = String(url || '').trim();
  const pasted = String(text || '').trim();
  if (!link && pasted.length < 10) return {error: '请粘贴链接，或粘贴至少 10 个字的正文', needText: true};
  let title = '', body = pasted, fetched = false;
  if (link) {
    if (!/^https?:\/\//i.test(link)) return {error: '链接需以 http:// 或 https:// 开头'};
    const res = await fetchText(link, {timeout: 20000, retries: 0, minInterval: 0, checkRobots: false});
    if (!res.ok) return {error: '链接打不开：' + res.message, needText: true};
    const parsed = parseArticleHtml(res.text);
    title = parsed.title;
    body = [parsed.text, pasted].filter(Boolean).join('\n');
    fetched = true;
  }
  if (body.length < 10) return {error: '正文太短，无法解析', needText: true};
  return {
    draft: extractDraft({text: body, title, url: link, kind}),
    preview: body.slice(0, 1500),
    fetched,
    source: link ? 'link' : 'text'
  };
}
