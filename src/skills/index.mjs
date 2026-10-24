// 技能扫描：每个技能一个目录，SKILL.md 顶部用 --- 包围的元信息。
// M7 阶段会补充具体技能；这里先把契约定下来，能力面板即可自动列出。
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

function parseFrontMatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (!key) continue;
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    meta[key] = value;
  }
  return meta;
}

export async function listSkills(root) {
  const base = join(root, 'src', 'skills');
  let entries = [];
  try { entries = await readdir(base, {withFileTypes: true}); } catch { return []; }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await readFile(join(base, entry.name, 'SKILL.md'), 'utf8');
      const meta = parseFrontMatter(text);
      skills.push({
        id: String(meta.id || entry.name),
        name: String(meta.name || entry.name),
        description: String(meta.description || ''),
        triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        writes: meta.writes === true,
        version: Number(meta.version || 1)
      });
    } catch { /* 没有 SKILL.md 的目录不算技能 */ }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export {parseFrontMatter};
