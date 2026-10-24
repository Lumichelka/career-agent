// 登录型网站注册表：同一套浏览器读取/搜索/截图逻辑复用到 BOSS、小红书、实习僧等。
export const PLATFORM_SITES = {
  boss: {
    id: 'boss',
    name: 'BOSS直聘',
    short: 'BOSS',
    home: 'https://www.zhipin.com/',
    domain: 'zhipin.com',
    loginHosts: ['zhipin.com'],
    kind: 'job',
    searchUrl: q => 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(q),
    searchWait: 'a[href*="job_detail"], .job-card-wrapper a',
    detail: /\/job_detail\//,
    readable: /^\/(web\/geek\/job|job_detail\/|web\/geek\/job-recommend|$)/,
    readHint: '岗位详情或搜索结果'
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    name: '小红书',
    short: '小红书',
    home: 'https://www.xiaohongshu.com/explore',
    domain: 'xiaohongshu.com',
    loginHosts: ['xiaohongshu.com'],
    kind: 'note',
    searchUrl: q => 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(q) + '&source=web_explore_feed',
    searchWait: 'a[href*="/explore/"], a[href*="/discovery/item/"]',
    detail: /\/(explore\/[^/]+|discovery\/item\/)/,
    readable: /^\/(explore|search_result|discovery\/item\/)/,
    readHint: '笔记或搜索结果'
  },
  shixiseng: {
    id: 'shixiseng',
    name: '实习僧',
    short: '实习僧',
    home: 'https://www.shixiseng.com/',
    domain: 'shixiseng.com',
    loginHosts: ['shixiseng.com'],
    kind: 'intern',
    searchUrl: q => 'https://www.shixiseng.com/interns?keyword=' + encodeURIComponent(q),
    searchWait: 'a[href*="/intern/"], a[href*="/job/"]',
    detail: /\/(intern|job)\/[^/]+/,
    readable: /^\/(interns|intern\/|job\/|search)/,
    readHint: '实习或职位页面'
  },
  nowcoder: {
    id: 'nowcoder',
    name: '牛客',
    short: '牛客',
    home: 'https://www.nowcoder.com/',
    domain: 'nowcoder.com',
    loginHosts: ['nowcoder.com'],
    kind: 'job',
    searchUrl: q => 'https://www.nowcoder.com/search?query=' + encodeURIComponent(q) + '&type=job',
    searchWait: 'a[href*="/jobs/"], a[href*="/job/"]',
    detail: /\/(jobs|job)\/[^/]+/,
    readable: /^\/(jobs|job\/|search|discuss)/,
    readHint: '职位或讨论页面'
  },
  zhaopin: {
    id: 'zhaopin',
    name: '智联招聘',
    short: '智联',
    home: 'https://www.zhaopin.com/',
    domain: 'zhaopin.com',
    loginHosts: ['zhaopin.com'],
    kind: 'job',
    searchUrl: q => 'https://sou.zhaopin.com/?kw=' + encodeURIComponent(q),
    searchWait: 'a[href*="jobdetail"], .joblist-box__item a',
    detail: /\/jobdetail\//,
    readable: /^\/(jobdetail\/|sou\/|$)/,
    readHint: '职位详情或搜索结果'
  },
  '51job': {
    id: '51job',
    name: '前程无忧',
    short: '51job',
    home: 'https://www.51job.com/',
    domain: '51job.com',
    loginHosts: ['51job.com'],
    kind: 'job',
    searchUrl: q => 'https://we.51job.com/pc/search?keyword=' + encodeURIComponent(q) + '&searchType=2',
    searchWait: 'a[href*="/pc/jobdetail"], .joblist-item a',
    detail: /\/pc\/jobdetail|\/job\//,
    readable: /^\/(pc\/search|pc\/jobdetail|job\/|$)/,
    readHint: '职位详情或搜索结果'
  },
  liepin: {
    id: 'liepin',
    name: '猎聘',
    short: '猎聘',
    home: 'https://www.liepin.com/',
    domain: 'liepin.com',
    loginHosts: ['liepin.com'],
    kind: 'job',
    searchUrl: q => 'https://www.liepin.com/zhaopin/?key=' + encodeURIComponent(q),
    searchWait: 'a[href*="/job/"], .job-card a',
    detail: /\/job\/[^/]+/,
    readable: /^\/(zhaopin|job\/|$)/,
    readHint: '职位详情或搜索结果'
  }
};

export const PLATFORM_IDS = Object.keys(PLATFORM_SITES);

export function siteById(id) {
  const site = PLATFORM_SITES[id];
  if (!site) throw new Error('不支持的网站');
  return site;
}

export function isPlatformId(id) {
  return Object.hasOwn(PLATFORM_SITES, id);
}
