#!/usr/bin/env node
// 提交信息门禁：类型 + 范围白名单 + 一句话说明。用法见 docs/plan/03-版本控制与协作.md。
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore'];

export const COMMIT_SCOPES = [
  'recruit', 'sources', 'wechat', 'source-check',
  'agent', 'skills', 'model',
  'web', 'ui', 'server', 'platform',
  'company', 'resume', 'interview', 'feed', 'mcp', 'memory', 'tools',
  'deploy', 'docs', 'ci',
  'acceptance', 'adr', 'plan', 'research', 'skill'
];

const HEADER = /^([a-z][a-z0-9]*)\(([a-z][a-z0-9-]*)\): (\S.*)$/;
const MERGE_OR_REVERT = /^(Merge |Revert )/;

export function validateCommitMessage(message) {
  const firstLine = String(message ?? '').replace(/\r\n/g, '\n').split('\n')[0].trim();
  const errors = [];
  if (!firstLine) {
    return {ok: false, errors: ['提交信息不能为空'], subject: ''};
  }
  if (MERGE_OR_REVERT.test(firstLine)) return {ok: true, errors: [], subject: firstLine};

  const match = HEADER.exec(firstLine);
  if (!match) {
    return {ok: false, errors: ['首行必须是 <类型>(<范围>): <一句话>，例如 feat(recruit): 补双选会分页'], subject: firstLine};
  }
  const [, type, scope, summary] = match;
  if (!COMMIT_TYPES.includes(type)) errors.push('未知类型：' + type + '（可用：' + COMMIT_TYPES.join(' / ') + '）');
  if (!COMMIT_SCOPES.includes(scope)) errors.push('未知范围：' + scope + '（可用范围见 docs/plan/03-版本控制与协作.md）');
  if (!summary.trim()) errors.push('说明不能为空');
  if (firstLine.length > 100) errors.push('首行不要超过 100 个字符');
  return {ok: errors.length === 0, errors, subject: firstLine};
}

function readMessageFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error('读不到提交信息文件：' + file + '（' + error.message + '）');
  }
}

function headMessage() {
  return execFileSync('git', ['log', '-1', '--format=%B', 'HEAD'], {encoding: 'utf8'});
}

function rangeMessages(range) {
  const shas = execFileSync('git', ['rev-list', '--no-merges', range], {encoding: 'utf8'})
    .trim().split('\n').filter(Boolean);
  return shas.map(sha => ({
    sha,
    message: execFileSync('git', ['log', '-1', '--format=%B', sha], {encoding: 'utf8'})
  }));
}

function report(entries) {
  const failures = [];
  for (const entry of entries) {
    const result = validateCommitMessage(entry.message);
    if (!result.ok) failures.push({...entry, ...result});
  }
  if (failures.length === 0) {
    console.log('✔ 提交信息检查通过（' + entries.length + ' 条）');
    return 0;
  }
  for (const failure of failures) {
    const short = failure.sha ? failure.sha.slice(0, 8) + ' ' : '';
    console.error('✖ ' + short + failure.subject);
    for (const error of failure.errors) console.error('  - ' + error);
  }
  return 1;
}

function main(argv) {
  if (argv[0] === '--range') {
    const range = argv[1];
    if (!range) throw new Error('用法：check-commit-msg.mjs --range <base..head>');
    return report(rangeMessages(range));
  }
  if (argv[0] === '--head') return report([{message: headMessage()}]);
  const file = argv[0];
  if (!file) throw new Error('用法：check-commit-msg.mjs <commit-msg 文件> | --head | --range <base..head>');
  return report([{message: readMessageFile(file)}]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('✖ ' + error.message);
    process.exitCode = 2;
  }
}
