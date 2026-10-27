import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {SOURCES, sourceHealth} from '../src/recruit/sources/index.mjs';
import {SOURCE_STATUSES, SOURCE_STATUS_LABELS} from '../src/recruit/source-status.mjs';

const DOC = readFileSync(new URL('../docs/plan/10-采集与生命周期.md', import.meta.url), 'utf8');

function sourceMatrix() {
  const start = DOC.indexOf('## 2. ');
  const end = DOC.indexOf('## 2.1', start);
  assert.ok(start >= 0 && end > start, '文档缺少 §2 来源矩阵');
  const section = DOC.slice(start, end);
  const rows = section.split('\n')
    .filter(line => line.startsWith('| `'))
    .map(line => {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      return {
        id: cells[0].replaceAll('`', ''),
        school: cells[1],
        list: cells[2],
        detail: cells[3],
        projects: cells[4],
        status: cells[5],
        note: cells[6]
      };
    });
  return {section, rows};
}

test('来源矩阵与注册表的 list/detail/projects 能力逐行一致', () => {
  const {rows} = sourceMatrix();
  const expected = new Map(SOURCES.map(source => {
    const caps = sourceHealth(source).capabilities;
    return [source.id, {list: caps.list, detail: caps.detail, projects: caps.projects}];
  }));

  assert.equal(rows.length, SOURCES.length, '矩阵行数应等于注册来源数');
  assert.deepEqual(rows.map(row => row.id), [...expected.keys()].sort(), '矩阵来源 id 应与注册表完全一致');

  for (const row of rows) {
    const caps = expected.get(row.id);
    assert.ok(caps, row.id + ' 不在注册表中');
    assert.equal(row.list, caps.list, row.id + ' list 能力与注册表不一致');
    assert.equal(row.detail, caps.detail, row.id + ' detail 能力与注册表不一致');
    assert.equal(row.projects, caps.projects, row.id + ' projects 能力与注册表不一致');
    assert.ok(SOURCE_STATUSES.includes(row.status), row.id + ' 状态不在七个规格状态内：' + row.status);
    assert.ok(row.note, row.id + ' 缺少维护提示');
  }
});

test('来源树列出目录下全部 .mjs 文件', () => {
  const start = DOC.indexOf('src/recruit/sources/');
  const end = DOC.indexOf('```', start);
  assert.ok(start >= 0 && end > start, '文档缺少来源代码树');
  const tree = DOC.slice(start, end);
  const files = readdirSync(new URL('../src/recruit/sources/', import.meta.url))
    .filter(file => file.endsWith('.mjs'))
    .sort();
  for (const file of files) {
    assert.ok(tree.includes(file), '来源树缺少 ' + file);
  }
});

test('来源文档不再保留待接入/待适配，并列出双选会分页源文件', () => {
  assert.doesNotMatch(DOC, /待接入|待适配|未适配/);
  assert.match(DOC, /swpu-jobfair\.mjs/);
});

test('状态语义表覆盖七个状态与中文文案', () => {
  const start = DOC.indexOf('### 3.1');
  const end = DOC.indexOf('\n---', start);
  assert.ok(start >= 0 && end > start, '文档缺少 §3.1 状态语义');
  const section = DOC.slice(start, end);
  for (const status of SOURCE_STATUSES) {
    assert.match(section, new RegExp('\\| `' + status + '` \\|'), '状态表缺少 ' + status);
    assert.ok(section.includes(SOURCE_STATUS_LABELS[status]), '状态表缺少文案：' + SOURCE_STATUS_LABELS[status]);
  }
});

test('活动项目表说明覆盖来源项目字段', () => {
  for (const field of ['source_id', 'source_key', 'status', 'confidence', 'first_seen_at', 'last_seen_at', 'missing_runs', 'raw_text']) {
    assert.match(DOC, new RegExp('`' + field + '`'), '文档缺少 event_projects 字段：' + field);
  }
});
