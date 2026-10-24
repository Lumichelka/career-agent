import test from 'node:test';
import assert from 'node:assert/strict';
import {PLATFORM_IDS, PLATFORM_SITES} from '../src/platform/sites.mjs';
import {allowedPlatformUrl, readablePath, searchUrl, validatePlatform} from '../src/platform/platforms.mjs';
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
