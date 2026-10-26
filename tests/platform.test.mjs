import test from 'node:test';
import assert from 'node:assert/strict';
import {PLATFORM_IDS, PLATFORM_SITES} from '../src/platform/sites.mjs';
import {allowedPlatformUrl, readablePath, searchUrl, validatePlatform, PlatformBrowser} from '../src/platform/platforms.mjs';
import {extractPlatformJobs} from '../src/platform/jobs.mjs';
import {ocrImage} from '../src/platform/ocr.mjs';

test('登录型网站注册表：7 个站点、字段完整、id 唯一', () => {
  assert.equal(PLATFORM_IDS.length, 7);
  assert.equal(new Set(PLATFORM_IDS).size, PLATFORM_IDS.length);
  for (const id of PLATFORM_IDS) {
    const s = PLATFORM_SITES[id];
    assert.equal(s.id, id);
    assert.ok(s.name && s.home && s.domain);
    assert.match(s.home, /^https:\/\//);
    assert.equal(typeof s.searchUrl, 'function');
    assert.ok(s.readable instanceof RegExp);
    assert.ok(s.detail instanceof RegExp);
  }
});

test('URL 白名单：只允许本站 https，拒绝外站和 http', () => {
  for (const id of PLATFORM_IDS) {
    const s = PLATFORM_SITES[id];
    assert.equal(allowedPlatformUrl(id, s.home), true);
    assert.equal(allowedPlatformUrl(id, 'https://evil.example.com/'), false);
    assert.equal(allowedPlatformUrl(id, s.home.replace('https:', 'http:')), false);
  }
  assert.throws(() => validatePlatform('nope'), /不支持/);
});

test('搜索地址：编码中文，拒绝联系方式', () => {
  const boss = searchUrl('boss', '成都 数据分析');
  assert.match(boss, /zhipin\.com/);
  assert.ok(boss.includes(encodeURIComponent('成都 数据分析')));
  assert.match(searchUrl('xiaohongshu', '某公司 面试'), /xiaohongshu\.com/);
  assert.throws(() => searchUrl('boss', '13800138000'), /电话|邮箱/);
  assert.throws(() => searchUrl('boss', 'a@b.com'), /电话|邮箱/);
});

test('可读路径：详情/搜索可读，登录页不可读', () => {
  assert.equal(readablePath('boss', 'https://www.zhipin.com/job_detail/abc.html'), true);
  assert.equal(readablePath('boss', 'https://www.zhipin.com/web/geek/job?query=x'), true);
  assert.equal(readablePath('boss', 'https://www.zhipin.com/web/user/login'), false);
  assert.equal(readablePath('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc'), true);
  assert.equal(readablePath('shixiseng', 'https://www.shixiseng.com/intern/abc'), true);
});

test('OCR：文件不存在时不伪造文字', async () => {
  const r = await ocrImage('definitely-not-exists.png');
  assert.equal(r.ok, false);
  assert.match(r.reason, /不存在/);
});

// ---- 平台岗位入库：从只读页面结果归一化成可入库的岗位（#51） ----
test('平台岗位抽取：列表链接归一化出岗位、城市、薪资与来源', () => {
  const jobs = extractPlatformJobs({
    platform: 'boss',
    url: 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE',
    pageTitle: '数据分析师招聘 - BOSS直聘',
    text: '',
    city: '成都',
    capturedAt: '2026-10-26T10:00:00.000Z',
    links: [
      {title: '数据分析师\n8-12K\n成都·武侯区\n1-3年\n本科', url: 'https://www.zhipin.com/job_detail/abc.html'},
      {title: '首页', url: 'https://www.zhipin.com/'},
      {title: '产品经理', url: 'https://www.zhipin.com/job_detail/def.html'}
    ]
  });
  assert.equal(jobs.length, 2);
  const job = jobs[0];
  assert.equal(job.platform, 'boss');
  assert.equal(job.title, '数据分析师');
  assert.equal(job.city, '成都');
  assert.match(job.positions, /8-12K/);
  assert.match(job.requirements, /1-3年|本科/);
  assert.equal(job.sourceUrl, 'https://www.zhipin.com/job_detail/abc.html');
  assert.match(job.sourceKey, /^[a-f0-9]{32}$/);
  assert.equal(job.fetchedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(job.confidence, 0.6, '列表链接只能算摘要置信度');
  assert.match(job.notes, /核对/);
});

test('平台岗位抽取：外站链接、重复链接与导航项都不入库', () => {
  const jobs = extractPlatformJobs({
    platform: 'boss',
    url: 'https://www.zhipin.com/web/geek/job',
    links: [
      {title: '数据分析师', url: 'https://evil.example.com/job_detail/x.html'},
      {title: '数据分析师', url: 'http://www.zhipin.com/job_detail/x.html'},
      {title: '数据分析师', url: 'https://www.zhipin.com/job_detail/x.html'},
      {title: '数据分析师', url: 'https://www.zhipin.com/job_detail/x.html'},
      {title: '登录', url: 'https://www.zhipin.com/web/user/login'}
    ]
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrl, 'https://www.zhipin.com/job_detail/x.html');
});

test('平台岗位抽取：城市只来自页面或明确传入，识别不到就留空不猜', () => {
  const links = [{title: '数据分析师', url: 'https://www.zhipin.com/job_detail/abc.html'}];
  const empty = extractPlatformJobs({platform: 'boss', links});
  assert.equal(empty[0].city, '');
  const given = extractPlatformJobs({platform: 'boss', city: '成都', links});
  assert.equal(given[0].city, '成都');
});

test('平台岗位抽取：公司名只在页面明确写出时记录', () => {
  const jobs = extractPlatformJobs({
    platform: 'boss',
    url: 'https://www.zhipin.com/job_detail/abc.html',
    pageTitle: '数据分析师-成都某某科技有限公司-BOSS直聘',
    links: [{title: '数据分析师', url: 'https://www.zhipin.com/job_detail/abc.html'}]
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, '成都某某科技有限公司');
  assert.equal(jobs[0].confidence, 0.7, '详情页置信度高于列表摘要');
});

test('平台岗位快照：只记录最近一次真实读取，供确认入库使用', () => {
  const browser = new PlatformBrowser('.');
  assert.equal(browser.lastRead('boss'), null, '没读过时没有快照');
  const snapshot = {
    url: 'https://www.zhipin.com/web/geek/job?query=x', title: '搜索', text: '数据分析师',
    links: [{title: '数据分析师', url: 'https://www.zhipin.com/job_detail/a.html'}],
    at: '2026-10-26T10:00:00.000Z', status: 'readable'
  };
  browser.recordRead('boss', snapshot);
  assert.deepEqual(browser.lastRead('boss'), snapshot);
  browser.recordRead('boss', {...snapshot, at: '2026-10-26T10:05:00.000Z'});
  assert.equal(browser.lastRead('boss').at, '2026-10-26T10:05:00.000Z', '后读覆盖先读');
  assert.equal(browser.lastRead('liepin'), null, '平台之间互不影响');
});
