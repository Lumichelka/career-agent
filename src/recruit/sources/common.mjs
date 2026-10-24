// 信息源共用的解析工具。
export const CATEGORIES = ['四川双一流', '财经强校', '双选会平台', '其他高校单位'];

export const DAY = (d, t = '00:00') => `${d}T${t}:00+08:00`;

export function parseDateText(text) {
  const m = String(text || '').match(/(20\d{2})[-年.\/](\d{1,2})[-月.\/](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

export function parseTimeRange(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*[-~—至到]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return [`${String(m[1]).padStart(2, '0')}:${m[2]}`, `${String(m[3]).padStart(2, '0')}:${m[4]}`];
}

export const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'").replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export function guessKind(title, fallback) {
  const t = String(title || '');
  if (/双选会|招聘会|洽谈会|供需见面/.test(t)) return '双选会';
  if (/宣讲|宣介|招聘说明/.test(t)) return '宣讲会';
  if (/培训|指导|讲座|工作坊|大讲堂|辅导/.test(t)) return '就业指导';
  if (/招聘公告|招聘信息|校招|秋招|春招|引才/.test(t)) return '招聘信息';
  return fallback || '其他';
}

export function guessCompany(title) {
  const t = String(title || '');
  const bracket = t.match(/【([^】]{2,30})】/);
  if (bracket) return bracket[1];
  const cut = t.split(/20\d{2}|届|校园招聘|宣讲会|双选会|招聘会|专场/)[0].replace(/[•·｜|—\-]+$/, '').trim();
  return cut.length >= 2 && cut.length <= 40 ? cut : '';
}

// "浙江省杭州市" / "上海市" / "成都" → "杭州" / "上海" / "成都"
export function normalizeCity(raw, fallback = '') {
  const s = String(raw || '').replace(/\s+/g, '').trim();
  if (!s) return fallback;
  const tail = s.split(/省|自治区|特别行政区/).pop().replace(/市$/, '');
  return tail && tail.length <= 8 ? tail : fallback;
}
