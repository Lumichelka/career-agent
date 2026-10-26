// 30 天证据清理：只删任务证据文件（截图/JSON/动作日志），不动 write_audit、不删任务卡。
// feed 仍返回 evidence_ref，但 evidence_available:false（ADR 0002）。
// 启动时跑一次，之后由 server 的定时器周期性跑；只扫 dataDir/users/<id>/tasks/<taskId>/evidence。
import {readdir, stat, unlink, rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {EVIDENCE_TTL_MS} from '../recruit/feed.mjs';

const UUID = /^[a-f0-9-]{36}$/;
const USER = /^[A-Za-z0-9._-]{1,120}$/;

async function removeExpiredFiles(dir, {cutoff, dryRun}) {
  let removedFiles = 0;
  let removedBytes = 0;
  let names = [];
  try { names = await readdir(dir); } catch { return {removedFiles, removedBytes, empty: false}; }
  for (const name of names) {
    const file = join(dir, name);
    let info;
    try { info = await stat(file); } catch { continue; }
    if (!info.isFile()) continue;
    if (info.mtimeMs > cutoff) continue;
    removedFiles += 1;
    removedBytes += Number(info.size) || 0;
    if (!dryRun) {
      try { await unlink(file); } catch { /* 已被并发清理 */ }
    }
  }
  let empty = false;
  try { empty = (await readdir(dir)).length === 0; } catch { empty = true; }
  if (empty && !dryRun) {
    // 目录空了就一并收掉；feed 对不存在的证据目录同样返回 evidence_available:false。
    try { await rmdir(dir); } catch { /* 非空/已删 */ }
  }
  return {removedFiles, removedBytes, empty};
}

// dryRun=true 只统计不删除，便于诊断/测试断言。
export async function purgeExpiredEvidence({dataDir, ttlMs = EVIDENCE_TTL_MS, now = Date.now(), dryRun = false} = {}) {
  if (!dataDir) return {scannedUsers: 0, scannedTasks: 0, removedFiles: 0, removedBytes: 0, dryRun};
  const cutoff = Number(now) - Math.max(0, Number(ttlMs) || EVIDENCE_TTL_MS);
  let users = [];
  try { users = await readdir(join(String(dataDir), 'users')); } catch { return {scannedUsers: 0, scannedTasks: 0, removedFiles: 0, removedBytes: 0, dryRun}; }
  let scannedTasks = 0;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const userId of users) {
    if (!USER.test(userId)) continue;
    const tasksDir = join(String(dataDir), 'users', userId, 'tasks');
    let taskIds = [];
    try { taskIds = await readdir(tasksDir); } catch { continue; }
    for (const taskId of taskIds) {
      if (!UUID.test(taskId)) continue;
      const evidenceDir = join(tasksDir, taskId, 'evidence');
      let info;
      try { info = await stat(evidenceDir); } catch { continue; }
      if (!info.isDirectory()) continue;
      scannedTasks += 1;
      const out = await removeExpiredFiles(evidenceDir, {cutoff, dryRun});
      removedFiles += out.removedFiles;
      removedBytes += out.removedBytes;
    }
  }
  return {scannedUsers: users.length, scannedTasks, removedFiles, removedBytes, dryRun, cutoff: new Date(cutoff).toISOString()};
}
