import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {COMMIT_SCOPES, COMMIT_TYPES, validateCommitMessage} from '../scripts/check-commit-msg.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('提交信息：合法类型与范围通过', () => {
  for (const type of COMMIT_TYPES) {
    const result = validateCommitMessage(type + '(recruit): 一条可执行的一句话');
    assert.equal(result.ok, true, type + ' 应通过：' + result.errors.join('；'));
  }
  for (const scope of COMMIT_SCOPES) {
    const result = validateCommitMessage('feat(' + scope + '): 一条可执行的一句话');
    assert.equal(result.ok, true, scope + ' 应通过：' + result.errors.join('；'));
  }
});

test('提交信息：未知类型、未知范围、缺少说明都被拒', () => {
  assert.equal(validateCommitMessage('wip(recruit): 临时提交').ok, false);
  assert.equal(validateCommitMessage('feat(ticket-38): 旧票号当范围').ok, false);
  assert.equal(validateCommitMessage('feat(recruit):').ok, false);
  assert.equal(validateCommitMessage('feat(recruit):   ').ok, false);
  assert.equal(validateCommitMessage('').ok, false);
});

test('提交信息：Merge / Revert 放行，普通信息不放行', () => {
  assert.equal(validateCommitMessage('Merge branch \'dev\'').ok, true);
  assert.equal(validateCommitMessage('Revert "feat(recruit): 一条可执行的一句话"').ok, true);
  assert.equal(validateCommitMessage('随便写一句').ok, false);
});

test('提交信息：当前 HEAD 能通过 CLI 检查', () => {
  const out = execFileSync(process.execPath, ['scripts/check-commit-msg.mjs', '--head'], {cwd: root, encoding: 'utf8'});
  assert.match(out, /提交信息检查通过/);
});
