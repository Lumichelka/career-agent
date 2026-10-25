import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// 自动发现同目录下的源文件：新增一所学校 = 新增一个文件。
const dir = new URL('.', import.meta.url);
const files = (await readdir(fileURLToPath(dir)))
  .filter(f => f.endsWith('.mjs') && f !== 'index.mjs' && f !== 'common.mjs')
  .sort();

const modules = await Promise.all(files.map(f => import(new URL(f, dir))));

export const SOURCES = modules
  .map(m => m.default)
  .filter(Boolean)
  .sort((a, b) => a.id.localeCompare(b.id));

export function sourceById(id) {
  const source = SOURCES.find(s => s.id === id);
  if (!source) throw new Error('未知信息源：' + id);
  return source;
}

export function enabledSources() {
  return SOURCES.filter(s => s.enabled);
}

export function sourceHealth(source) {
  return {
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    mode: source.mode,
    category: source.category,
    note: source.note || '',
    fallback: source.fallback || '',
    capabilities: {
      ...(source.capabilities || {list: source.mode, detail: source.detail ? 'http' : 'none', projects: typeof source.fetchProjects === 'function' ? 'custom' : 'none'}),
      manual: typeof source.parseList === 'function'
    }
  };
}

export * from './common.mjs';
