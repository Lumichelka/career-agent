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

// 已下线来源（墓碑）：源码文件已移除，但库里仍有历史活动。
// 对账时用它们把孤儿源留在 sources 表里并标 orphaned，保证活动能追到历史来源，而不是删除谱系。
export const REMOVED_SOURCES = [
  {
    id: 'nankai-recruitment',
    name: '南开大学 · 双选会信息',
    school: '南开大学',
    city: '天津',
    category: '财经强校',
    channel: '就业信息网',
    kind: '双选会',
    mode: 'static',
    listUrl: 'https://career.nankai.edu.cn/recruitment/index.html',
    enabled: false,
    note: '来源已下线：历史活动保留，不再采集。'
  },
  {
    id: 'sysu-home',
    name: '中山大学 · 首页宣讲会摘要',
    school: '中山大学',
    city: '广州',
    category: '财经强校',
    channel: '就业信息网',
    kind: '宣讲会',
    mode: 'static',
    listUrl: 'https://career.sysu.edu.cn/',
    enabled: false,
    note: '来源已下线：历史活动保留，不再采集。'
  }
];

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
      manual: true
    }
  };
}

export * from './common.mjs';
