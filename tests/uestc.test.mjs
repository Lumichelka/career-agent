import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import source, {parseUestcCalendar} from '../src/recruit/sources/uestc.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/uestc-calendar.json', import.meta.url), 'utf8'));

test('电子科大：现场日历解析', () => {
  const items = parseUestcCalendar(fixture);
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '中国工程物理研究院');
  assert.equal(items[0].startAt, '2026-10-08T09:30:00+08:00');
  assert.equal(items[0].endAt, '2026-10-08T11:30:00+08:00');
  assert.equal(items[0].kind, '宣讲会');
});

test('电子科大：使用日历接口且无需项目能力', () => {
  assert.match(source.listUrl, /\/api\/home\/calendar\?month=/);
  assert.equal(source.enabled, true);
  assert.equal(source.capabilities.projects, 'none');
});
