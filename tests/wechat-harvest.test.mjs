import test from 'node:test';
import assert from 'node:assert/strict';
import {findWechatLinks} from '../src/wechat/harvest.mjs';
import {analyzeArticle} from '../src/wechat/analyze.mjs';
import {fetchWechatArticle} from '../src/wechat/fetch-article.mjs';

test('来源页：发现并规范化公众号文章链接', () => {
  const html = '<a href="http://mp.weixin.qq.com/s?__biz=abc&amp;mid=1">一</a><a href="https://mp.weixin.qq.com/s/xyz#rd">二</a><a href="https://example.com">三</a>';
  const links = findWechatLinks(html);
  assert.equal(links.length, 2);
  assert.ok(links.every(l => l.startsWith('https://mp.weixin.qq.com/s')));
  assert.ok(links.every(l => !l.includes('&amp;')));
});

test('文章分析：月历/邀请函噪声不产生假项目', () => {
  const monthly = analyzeArticle({
    title: '@中大学子 你有一份2026就业升学月历待查收',
    text: '求职 寒假实习招聘仍在报名。\n中山大学就业\n主动与学校进行联系\n成绩公布后\n部分市区春招开始报名\n计划就业的应届毕业生可以先明确目标。',
    url: 'https://mp.weixin.qq.com/s/monthly'
  });
  assert.equal(monthly.projects.length, 0);
  const invite = analyzeArticle({
    title: '2027届毕业生推介手册&校园招聘活动邀请函',
    text: '中山大学2027届毕业生推介手册&2026年秋季学期校园招聘活动邀请函\n请使用电脑访问 “中山大学就业信息网”\n欢迎各地组织部门、人力资源和社会保障部门、人才交流中心',
    url: 'https://mp.weixin.qq.com/s/invite'
  });
  assert.equal(invite.projects.length, 0);
});

test('文章分析：真实单位 + 招聘行能拆出项目', () => {
  const a = analyzeArticle({
    title: '双选会通知',
    text: '双选会时间：2026年11月20日 14:00\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师',
    url: 'https://mp.weixin.qq.com/s/recruit'
  });
  assert.equal(a.hasRecruitment, 'yes');
  assert.deepEqual(a.projects.map(p => p.company), ['浙江吉利控股集团有限公司', '宇树科技股份有限公司']);
  assert.equal(a.projects[0].title, '数据分析');
});

test('非公众号链接不进入正文抓取', async () => {
  const out = await fetchWechatArticle('https://example.com/article');
  assert.equal(out.ok, false);
  assert.match(out.message, /有效的公众号/);
});
