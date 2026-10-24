// 信息源注册表：每所高校/平台一个条目，声明"怎么取、怎么解析、失败怎么办"。
// 只有真正验证过能拿到数据的源才 enabled；其余标出原因，避免把"抓不到"说成"没有活动"。

export const CATEGORIES = ['四川双一流', '财经强校', '双选会平台', '其他高校单位'];

const DAY = (d, t = '00:00') => `${d}T${t}:00+08:00`;

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

const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'").replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

function guessKind(title, fallback) {
  const t = String(title || '');
  if (/双选会|招聘会|洽谈会|供需见面/.test(t)) return '双选会';
  if (/宣讲|宣介|招聘说明/.test(t)) return '宣讲会';
  if (/培训|指导|讲座|工作坊|大讲堂|辅导/.test(t)) return '就业指导';
  if (/招聘公告|招聘信息|校招|秋招|春招|引才/.test(t)) return '招聘信息';
  return fallback || '其他';
}

function guessCompany(title) {
  const t = String(title || '');
  const bracket = t.match(/【([^】]{2,30})】/);
  if (bracket) return bracket[1];
  const cut = t.split(/20\d{2}|届|校园招聘|宣讲会|双选会|招聘会|专场/)[0].replace(/[•·｜|—\-]+$/, '').trim();
  return cut.length >= 2 && cut.length <= 40 ? cut : '';
}

export const SOURCES = [
  {
    id: 'scu-employ',
    name: '四川大学 · 校园宣讲会',
    school: '四川大学',
    city: '成都',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'static',
    enabled: true,
    listUrl: 'https://jy.scu.edu.cn/index/index/employ.html',
    note: '线下宣讲（未开始）列表，含举办日期/地点/单位名称，静态 HTML 可直取。',
    parseList(html, source) {
      const out = [];
      const re = /<li>\s*<span class="list1_time">([^<]+)<\/span>\s*<span class="list1_time">([^<]+)<\/span>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      for (const m of html.matchAll(re)) {
        const date = parseDateText(m[1]);
        const times = parseTimeRange(m[1]);
        if (!date) continue;
        const title = strip(m[4]);
        out.push({
          title,
          company: '',
          startAt: DAY(date, times ? times[0] : '09:00'),
          endAt: times ? DAY(date, times[1]) : '',
          venue: strip(m[2]),
          city: source.city,
          url: new URL(m[3], source.listUrl).href,
          kind: '宣讲会'
        });
      }
      return out;
    }
  },
  {
    id: 'scu-jobfair',
    name: '四川大学 · 双选会',
    school: '四川大学',
    city: '成都',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '双选会',
    mode: 'static',
    enabled: true,
    listUrl: 'https://jy.scu.edu.cn/index/index/jobfair.html',
    note: '线下双选会列表，含开始时间与活动名称。',
    parseList(html, source) {
      const out = [];
      const re = /<li><span class="list1_time">([^<]+)<\/span><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      for (const m of html.matchAll(re)) {
        const date = parseDateText(m[1]);
        const times = parseTimeRange(m[1]) || (m[1].match(/(\d{1,2}):(\d{2})/) ? [m[1].match(/(\d{1,2}):(\d{2})/)[0], ''] : null);
        if (!date) continue;
        const title = strip(m[3]);
        out.push({
          title,
          company: '',
          startAt: DAY(date, times?.[0] || '09:00'),
          endAt: times?.[1] ? DAY(date, times[1]) : '',
          venue: title.includes('江安') ? '四川大学江安校区' : title.includes('华西') ? '四川大学华西校区' : '四川大学望江校区',
          city: source.city,
          url: new URL(m[2], source.listUrl).href,
          kind: '双选会'
        });
      }
      return out;
    }
  },
  {
    id: 'nankai-recruitment',
    name: '南开大学 · 双选会信息',
    school: '南开大学',
    city: '天津',
    category: '财经强校',
    channel: '就业信息网',
    kind: '双选会',
    mode: 'static',
    enabled: true,
    listUrl: 'https://career.nankai.edu.cn/recruitment/index.html',
    detail: true,
    note: '列表给日期，详情页含"时间/地点"，需要再抓一次详情。',
    parseList(html, source) {
      const out = [];
      const re = /<li>\s*<a href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>\s*<span>([^<]*)<\/span>/g;
      for (const m of html.matchAll(re)) {
        const date = parseDateText(m[3]);
        const title = strip(m[2]);
        if (!date || !title) continue;
        out.push({title, company: '', startAt: DAY(date, '09:00'), endAt: '', venue: '', city: source.city, url: new URL(m[1], source.listUrl).href, kind: guessKind(title, '双选会')});
      }
      return out;
    },
    parseDetail(text) {
      const t = String(text || '');
      const date = parseDateText((t.match(/时间[:：]\s*(20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2})/) || [])[1] || '');
      const timeText = (t.match(/(\d{1,2}:\d{2}\s*[-~—至到]\s*\d{1,2}:\d{2})/) || [])[1] || '';
      const times = parseTimeRange(timeText);
      const venue = ((t.match(/地点[:：]\s*([^\s，。;；]{2,60})/) || [])[1] || '').trim();
      return {date, startTime: times?.[0] || '', endTime: times?.[1] || '', venue};
    }
  },
  {
    id: 'sufe-xjh',
    name: '上海财经大学 · 宣讲会（JSON 接口）',
    school: '上海财经大学',
    city: '上海',
    category: '财经强校',
    channel: '就业信息网（数据接口）',
    kind: '宣讲会',
    mode: 'json',
    enabled: true,
    listUrl: 'https://career.sufe.edu.cn/career/xjhxx/search/01/1/10',
    // 匿名访问每页最多 10 条（20 条起要求登录），因此按页翻。
    pageUrl: p => `https://career.sufe.edu.cn/career/xjhxx/search/01/${p}/10`,
    maxPages: 3,
    request: {method: 'POST', headers: {'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest'}, body: '{}'},
    note: '页面本身是 JS 渲染，但底层 JSON 接口可直连：返回单位、日期、时段、场地、行业、规模。',
    parseList(_html, _source, json) {
      const list = json?.data?.list || [];
      return list.map(r => {
        const date = String(r.jbrq || '');
        const times = parseTimeRange(r.jbsjdmc) || (r.jbsjdmc ? [String(r.jbsjdmc).slice(0, 5), ''] : null);
        return {
          title: String(r.xjhzt || r.dwmc || '').trim(),
          company: String(r.dwmc || '').trim(),
          startAt: date ? DAY(date, times?.[0] || '09:00') : '',
          endAt: times?.[1] ? DAY(date, times[1]) : '',
          venue: String(r.cddz || r.cdmc || '').trim(),
          city: String(r.szsmc || '上海'),
          industry: String(r.hyyjmc || ''),
          companySize: String(r.rsgmmc || ''),
          positions: String(r.zpxxid ? '' : ''),
          url: 'https://career.sufe.edu.cn/career/xjhxx/view/' + r.xjhid,
          kind: '宣讲会'
        };
      }).filter(x => x.title && x.startAt);
    }
  },
  {
    id: 'sysu-home',
    name: '中山大学 · 首页宣讲会摘要',
    school: '中山大学',
    city: '广州',
    category: '财经强校',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'static',
    enabled: true,
    listUrl: 'https://career.sysu.edu.cn/',
    note: '首页可见若干条宣讲会与日期；详情页需要统一身份认证，因此只收录标题与日期。',
    parseList(html, source) {
      const out = [];
      const re = /href="(\/teachin\/view\/id\/\d+)"[^>]*>([^<]{4,100})<\/a>[\s\S]{0,240}?(20\d{2}-\d{2}-\d{2})/g;
      for (const m of html.matchAll(re)) {
        const title = strip(m[2]);
        out.push({title, company: guessCompany(title), startAt: DAY(m[3], '09:00'), endAt: '', venue: '', city: source.city, url: new URL(m[1], source.listUrl).href, kind: '宣讲会'});
      }
      return out;
    }
  },
  {
    id: 'sicau-xjh',
    name: '四川农业大学 · 校园招聘会',
    school: '四川农业大学',
    city: '成都/雅安',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://job.sicau.edu.cn/zpxx/xyxjh/',
    note: '列表由前端异步加载，静态抓取只得到空壳；需要浏览器模式或找站点接口。'
  },
  {
    id: 'swufe-xjh',
    name: '西南财经大学 · 宣讲会',
    school: '西南财经大学',
    city: '成都',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://job3.swufe.edu.cn/',
    note: '站点分主站与 job3 子系统，栏目多为脚本渲染；待适配浏览器 / 接口。'
  },
  {
    id: 'uestc-xjh',
    name: '电子科技大学 · 宣讲会',
    school: '电子科技大学',
    city: '成都',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://jiuye.uestc.edu.cn/career/',
    note: '单页应用，需浏览器渲染；列表为空不代表没有活动。'
  },
  {
    id: 'swjtu-xjh',
    name: '西南交通大学 · 宣讲会',
    school: '西南交通大学',
    city: '成都',
    category: '四川双一流',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://jiuye.swjtu.edu.cn/career/index#1',
    note: '单页应用 + 需登录；建议浏览器模式或关注其公众号。'
  },
  {
    id: 'cufe-scc',
    name: '中央财经大学 · 就业信息网',
    school: '中央财经大学',
    city: '北京',
    category: '财经强校',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'static',
    enabled: false,
    listUrl: 'https://scc.cufe.edu.cn/',
    note: '本次测试连接超时（可能是站点侧 IP 限制或网络策略），属于需求中提到的"抓取失败"，需要备用通道。',
    fallback: '官方微信公众号「中央财经大学就业指导中心」+ 人工转发链接解析'
  },
  {
    id: 'uibe-career',
    name: '对外经济贸易大学 · 就业创业指导中心',
    school: '对外经济贸易大学',
    city: '北京',
    category: '财经强校',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'static',
    enabled: false,
    listUrl: 'https://career.uibe.edu.cn/',
    note: '站点可达，栏目结构待适配。'
  },
  {
    id: 'ncss',
    name: '国家大学生就业服务平台（24365）',
    school: '全国',
    city: '全国',
    category: '双选会平台',
    channel: '官方平台',
    kind: '双选会',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://www.ncss.cn/',
    note: '全国性双选会与岗位聚合，需登录后浏览；适合作为"大范围双选会"补充源。'
  },
  {
    id: 'iguopin',
    name: '国聘 · 校园招聘',
    school: '全国',
    city: '全国',
    category: '双选会平台',
    channel: '官方平台',
    kind: '招聘信息',
    mode: 'browser',
    enabled: false,
    listUrl: 'https://www.iguopin.com/',
    note: '央国企校招聚合，页面为前端渲染。'
  }
];

export function sourceById(id) {
  const s = SOURCES.find(x => x.id === id);
  if (!s) throw new Error('未知信息源：' + id);
  return s;
}

export function enabledSources() {
  return SOURCES.filter(s => s.enabled);
}

export {guessKind, guessCompany, strip};

// "浙江省杭州市" / "上海市" / "成都" → "杭州" / "上海" / "成都"
export function normalizeCity(raw, fallback = '') {
  const s = String(raw || '').replace(/\s+/g, '').trim();
  if (!s) return fallback;
  const tail = s.split(/省|自治区|特别行政区/).pop().replace(/市$/, '');
  return tail && tail.length <= 8 ? tail : fallback;
}

