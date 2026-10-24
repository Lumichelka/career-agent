// 数据目录解析与旧数据迁移。
// 目标：代码留在项目里，简历/账号/密钥/采集库放到用户数据目录。
import os from 'node:os';
import {join, resolve} from 'node:path';
import {mkdir, cp, writeFile, access} from 'node:fs/promises';

export function resolveDataDir({env = process.env, platform = process.platform, home = os.homedir()} = {}) {
  if (env.CAREER_DATA_DIR) return resolve(env.CAREER_DATA_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ZhiXiang');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ZhiXiang');
  return join(home, '.zhixiang');
}

export function legacyDataDir(root) {
  return join(root, '.data');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// 首次启动：如果项目内还有旧 .data，且新目录还没有账号，就复制过去（不删除旧目录）。
export async function prepareDataDir({root, log = () => {}} = {}) {
  const target = resolveDataDir();
  await mkdir(target, {recursive: true});
  const legacy = legacyDataDir(root);
  if (resolve(legacy) === resolve(target)) return target;
  const legacyAccounts = join(legacy, 'accounts.json');
  const targetAccounts = join(target, 'accounts.json');
  if (await exists(legacyAccounts) && !(await exists(targetAccounts))) {
    log('检测到项目内旧数据，正在迁移到：' + target);
    await cp(legacy, target, {recursive: true, force: false, errorOnExist: false});
    await writeFile(join(target, '.migrated.json'), JSON.stringify({from: legacy, at: new Date().toISOString()}, null, 2), 'utf8');
    log('迁移完成。旧目录仍保留，确认无误后可自行删除。');
  }
  return target;
}
