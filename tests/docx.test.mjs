import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDocx, zipStore, markdownToDocumentXml} from '../src/resume/docx.mjs';
import {handleResume} from '../src/resume/api.mjs';

// 读取 store 方式的 ZIP 条目（用于校验生成内容，不依赖第三方库）。
function readEntry(buffer, name) {
  let off = 0;
  while (off + 30 <= buffer.length && buffer.readUInt32LE(off) === 0x04034b50) {
    const size = buffer.readUInt32LE(off + 18);
    const nameLen = buffer.readUInt16LE(off + 26);
    const extra = buffer.readUInt16LE(off + 28);
    const entryName = buffer.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extra;
    if (entryName === name) return buffer.subarray(start, start + size);
    off = start + size;
  }
  return null;
}

test('DOCX：ZIP 结构完整，包含 document.xml / styles.xml', () => {
  const buf = buildDocx('# 张三\n\n## 教育经历\n- 某大学 金融学', {title: '测试简历'});
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const doc = readEntry(buf, 'word/document.xml');
  assert.ok(doc);
  assert.match(doc.toString('utf8'), /张三/);
  assert.match(doc.toString('utf8'), /Heading1/);
  assert.ok(readEntry(buf, 'word/styles.xml'));
  assert.ok(readEntry(buf, '[Content_Types].xml'));
});

test('DOCX：Markdown 标题/列表转换与 XML 转义', () => {
  const xml = markdownToDocumentXml('# 标题\n- 项目 A & B\n普通 <文本>', '标题');
  assert.match(xml, /Heading1/);
  assert.match(xml, /• 项目 A &amp; B/);
  assert.match(xml, /普通 &lt;文本&gt;/);
});

test('DOCX：zipStore 可读回多个条目', () => {
  const zip = zipStore({'a.txt': 'hello', 'b/c.txt': '世界'});
  assert.equal(readEntry(zip, 'a.txt').toString(), 'hello');
  assert.equal(readEntry(zip, 'b/c.txt').toString(), '世界');
});

test('API：按版本导出 docx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-docx-'));
  try {
    const created = await handleResume({method: 'POST', pathname: 'resumes', body: {name: '简历', content: '# 李四\n\n- SQL'}, dir});
    const versionId = created.json.resume.versions[0].id;
    const out = await handleResume({method: 'GET', pathname: 'resumes/version/' + versionId + '/docx', dir});
    assert.equal(out.file.name, 'zhixiang-resume.docx');
    assert.match(out.file.type, /wordprocessingml/);
    assert.equal(out.file.body.subarray(0, 2).toString(), 'PK');
    const doc = readEntry(out.file.body, 'word/document.xml').toString('utf8');
    assert.match(doc, /李四/);
    assert.match(doc, /SQL/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
