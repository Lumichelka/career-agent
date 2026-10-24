// 备份数据目录：把账号、招聘库、简历、密钥整体复制到 backups/，并写清单。
import {cp, mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {resolveDataDir} from '../src/config/paths.mjs';

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backupDataDir({
  dataDir = resolveDataDir(),
  backupRoot = join(process.cwd(), 'backups'),
  keep = 5,
  log = () => {}
} = {}) {
  const source = resolve(dataDir);
  const root = resolve(backupRoot);
  if (root === source || root.startsWith(source + sep)) throw new Error('备份目录不能放在数据目录里面');
  await mkdir(root, {recursive: true});

  const name = `zhixiang-${stamp()}-${randomBytes(2).toString('hex')}`;
  const target = join(root, name);
  await cp(source, target, {recursive: true, force: false, errorOnExist: false});

  const files = await walk(target);
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = {
    app: '职向', version: pkg.version, createdAt: new Date().toISOString(),
    source, files: files.length, bytes
  };
  await writeFile(join(target, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const entries = (await readdir(root, {withFileTypes: true}))
    .filter(e => e.isDirectory() && e.name.startsWith('zhixiang-'))
    .map(e => e.name).sort().reverse();
  for (const old of entries.slice(Math.max(1, keep))) await rm(join(root, old), {recursive: true, force: true});

  log(`已备份 ${files.length} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）到 ${target}`);
  return {target, files: files.length, bytes, version: pkg.version, kept: Math.min(entries.length, Math.max(1, keep))};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const keep = Number(process.env.CAREER_BACKUP_KEEP || 5);
  const backupRoot = process.env.CAREER_BACKUP_DIR || join(process.cwd(), 'backups');
  backupDataDir({backupRoot, keep, log: console.log})
    .then(r => console.log(`清单：${join(r.target, 'backup-manifest.json')}`))
    .catch(e => { console.error('备份失败：' + e.message); process.exitCode = 1; });
}
