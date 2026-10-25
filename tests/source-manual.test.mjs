import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleRecruit} from '../src/recruit/api.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const fixture = readFileSync(new URL('./fixtures/swpu-jobfairs.json', import.meta.url), 'utf8');

test('手工来源页：预览不写库，确认后才写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-manual-source-'));
  try {
    let out = await handleRecruit({method: 'POST', pathname: 'source-parse', body: {sourceId: 'swpu-jobfair', html: fixture}, dir});
    assert.equal(out.status || 200, 200);
    assert.equal(out.json.count, 1);
    assert.equal(out.json.preview.length, 1);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    assert.equal(store.listEvents({from: '2026-01-01T00:00:00+08:00', to: '2027-01-01T00:00:00+08:00'}).length, 0);
    store.close();
    out = await handleRecruit({method: 'POST', pathname: 'source-save', body: {sourceId: 'swpu-jobfair', html: fixture, confirm: true}, dir});
    assert.equal(out.json.created, 1);
    const check = RecruitStore.open(join(dir, 'recruit.db'));
    assert.equal(check.listEvents({from: '2026-01-01T00:00:00+08:00', to: '2027-01-01T00:00:00+08:00'}).length, 1);
    check.close();
  } finally { await rm(dir, {recursive: true, force: true}); }
});
