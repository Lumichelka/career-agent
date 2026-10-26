// 平台岗位归一化（#51）：把本人登录后只读页面里真实出现的岗位链接整理成可入库的项目行。
// 原则：只整理页面已经写出的标题/城市/薪资/学历；识别不到就留空，不猜单位、不补城市、不编薪资、不代投递。
import {createHash} from 'node:crypto';
import {siteById, isPlatformId, siteUrlAllowed} from './sites.mjs';
import {canonicalHttpUrl} from '../lib/url.mjs';

// 常见城市只用于识别页面上已写出的地点；不在表里的城市一律留空，不猜。
const CITY_NAMES = ['北京', '上海', '天津', '重庆', '广州', '深圳', '成都', '杭州', '南京', '武汉', '西安', '苏州', '长沙', '郑州', '东莞', '佛山', '合肥', '青岛', '沈阳', '大连', '厦门', '福州', '济南', '昆明', '哈尔滨', '长春', '石家庄', '南昌', '贵阳', '南宁', '太原', '兰州', '乌鲁木齐', '呼和浩特', '海口', '银川', '西宁', '拉萨', '无锡', '宁波', '温州', '常州', '徐州', '烟台', '珠海', '中山', '惠州', '嘉兴', '绍兴', '台州', '金华', '泉州', '保定', '廊坊', '洛阳', '香港', '澳门'];
const CITY_AT_START = new RegExp('^(' + CITY_NAMES.join('|') + ')(?:市)?(?:[·・].*)?$');
const SALARY = /(?:\d+(?:\.\d+)?\s*[-~—–至]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:[kK]|千|万|元)(?:\s*\/\s*(?:月|天|时|年))?/;
const REQUIREMENT = /(?:\d+\s*[-~—–至]?\s*\d*\s*年(?:以上|以下)?|应届|在校|本科|硕士|博士|大专|中专|高中|学历不限|经验不限)/;
const STRONG_COMPANY = /(有限公司|有限责任公司|股份有限公司|集团|银行|医院|学校|大学|学院|研究院|研究所|事务所|工作室|股份)/;
const ROLE_WORD = /(经理|工程师|专员|助理|主管|总监|顾问|运营|开发|设计|销售|客服|教师|医生|护士|会计|出纳|律师|分析师|研究员|实习生|文员|店长|组长|主任|编辑|策划)/;
const JUNK = /^(首页|登录|注册|更多|搜索|上一页|下一页|查看全部|展开|收起|消息|我的|导航|返回|下载|APP|客服|帮助|意见反馈|求职|招聘|校园招聘|社会招聘|推荐|热门|最新)$/i;
const SITE_WORD = /(BOSS直聘|小红书|实习僧|牛客|智联招聘|前程无忧|51job|猎聘)/i;
const PAGE_NOISE = /(招聘|直聘|官网|校园招聘|社会招聘|职位|岗位)$/;

function cleanToken(value) {
  return String(value ?? '')
    .replace(/^[\s「『【\[(（]+|[\s」』】\])）]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 列表链接的 innerText 常用换行/竖线/圆点分隔字段；单个连字符可能是薪资区间或公司名，只有带空格时才当分隔符。
function linkTokens(raw) {
  return String(raw ?? '')
    .split(/[\n\r\t|｜•]+/)
    .flatMap(part => part.split(/\s+[·・]\s+/))
    .flatMap(part => part.split(/\s+[-—–]\s+/))
    .flatMap(part => part.split(/ {2,}/))
    .map(cleanToken)
    .filter(Boolean);
}

// 详情页 title 一般用连字符/下划线拼「岗位-单位-站点」。
function pageTitleTokens(raw) {
  return String(raw ?? '')
    .split(/[\n\r\t|｜_\-—–]+/)
    .flatMap(part => part.split(/\s+[·・]\s+/))
    .map(cleanToken)
    .filter(Boolean);
}

function cityOf(token) {
  const t = String(token ?? '').replace(/\s+/g, '');
  if (!t || SITE_WORD.test(t)) return '';
  const matched = t.match(CITY_AT_START);
  return matched ? matched[1] : '';
}

function salaryOf(token) {
  const matched = String(token ?? '').match(SALARY);
  return matched ? matched[0].trim() : '';
}

function companyOf(token) {
  const t = String(token ?? '').trim();
  if (t.length < 3 || t.length > 40) return '';
  if (ROLE_WORD.test(t)) return '';
  if (!STRONG_COMPANY.test(t)) return '';
  return t.replace(PAGE_NOISE, '').trim();
}

function companyFromText(text) {
  const matched = String(text ?? '').match(/(?:公司|单位|企业|招聘方|招聘单位)[:：]\s*([^\n，,；;]{2,40})/);
  if (!matched) return '';
  const name = cleanToken(matched[1]);
  return ROLE_WORD.test(name) ? '' : name;
}

function normalizeCapturedAt(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function parseCandidate(raw, {fromPageTitle = false, defaultCity = '', text = ''} = {}) {
  const tokens = (fromPageTitle ? pageTitleTokens(raw) : linkTokens(raw))
    .filter(token => !JUNK.test(token) && !SITE_WORD.test(token));
  if (!tokens.length) return null;
  let city = '', salary = '', company = '';
  const requirements = [], rest = [];
  for (const token of tokens) {
    const foundCity = cityOf(token);
    if (foundCity && !city) { city = foundCity; continue; }
    const foundSalary = salaryOf(token);
    if (foundSalary && !salary) { salary = foundSalary; continue; }
    if (REQUIREMENT.test(token) && token.length <= 24) { requirements.push(token); continue; }
    const foundCompany = companyOf(token);
    if (foundCompany && !company) { company = foundCompany; continue; }
    rest.push(token);
  }
  // 详情页 title 的「岗位-单位-站点」结构：没有强公司标记时，把第二个可读片段当单位，去掉「招聘」等尾巴。
  if (fromPageTitle && !company && rest.length >= 2) {
    const candidate = rest[1].replace(PAGE_NOISE, '').trim();
    if (candidate.length >= 2 && !ROLE_WORD.test(candidate) && !cityOf(candidate)) {
      company = candidate;
      rest.splice(1, 1);
    }
  }
  if (!company && fromPageTitle) company = companyFromText(text);
  let title = rest[0] || '';
  if (fromPageTitle) title = title.replace(PAGE_NOISE, '').trim();
  if (!title || JUNK.test(title) || title.length < 2) return null;
  return {company, title, city: city || defaultCity, salary, requirements};
}

function makeJob({platform, parsed, url, confidence, capturedAt, rawText}) {
  const {company, title, city, salary, requirements} = parsed;
  const sourceKey = createHash('sha1').update([platform, canonicalHttpUrl(url), company, title].join('|')).digest('hex').slice(0, 32);
  return {
    platform,
    company,
    title,
    positions: salary ? '薪资 ' + salary : '',
    requirements: requirements.join('；'),
    city,
    sourceUrl: url,
    sourceKey,
    confidence,
    notes: confidence >= 0.7 ? '来自平台详情页，关键信息请回原页面核对；未代投递。' : '来自平台列表摘要，需点开详情核对；未代投递。',
    rawText: String(rawText ?? '').slice(0, 1000),
    fetchedAt: capturedAt
  };
}

/**
 * 从一个只读页面结果里抽取可入库岗位。
 * 只接受本平台 https 白名单内的详情链接；当前详情页本身也算一条（置信度高于列表摘要）。
 * 返回 [{platform, company, title, positions, requirements, city, sourceUrl, sourceKey, confidence, notes, rawText, fetchedAt}]。
 */
export function extractPlatformJobs({platform, url = '', pageTitle = '', text = '', links = [], city = '', capturedAt} = {}) {
  if (!isPlatformId(platform)) throw new Error('不支持的网站');
  const site = siteById(platform);
  const defaultCity = cityOf(String(city || '')) || '';
  const captured = normalizeCapturedAt(capturedAt);
  const pageUrl = String(url || '');
  const pageAllowed = siteUrlAllowed(platform, pageUrl);
  const pageDetail = pageAllowed && site.detail.test(new URL(pageUrl).pathname);
  const jobs = [], seen = new Set();
  const push = job => {
    const key = canonicalHttpUrl(job.sourceUrl) + '|' + job.title;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(job);
  };

  // 当前就是详情页：先用页面本身生成一条（比列表摘要更可靠）。
  if (pageDetail) {
    const parsed = parseCandidate(pageTitle, {fromPageTitle: true, defaultCity, text});
    if (parsed) push(makeJob({platform, parsed, url: pageUrl, confidence: 0.7, capturedAt: captured, rawText: [pageTitle, text].filter(Boolean).join('\n')}));
  }

  for (const link of Array.isArray(links) ? links : []) {
    const linkUrl = String(link?.url || '');
    if (!siteUrlAllowed(platform, linkUrl)) continue;
    let pathname;
    try { pathname = new URL(linkUrl).pathname; } catch { continue; }
    if (!site.detail.test(pathname)) continue;
    const parsed = parseCandidate(link?.title, {defaultCity});
    if (!parsed) continue;
    const confidence = pageDetail && canonicalHttpUrl(linkUrl) === canonicalHttpUrl(pageUrl) ? 0.7 : 0.6;
    push(makeJob({platform, parsed, url: linkUrl, confidence, capturedAt: captured, rawText: link?.title || ''}));
  }

  return jobs.slice(0, 50);
}
