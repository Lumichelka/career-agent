// 打印当前注册的工具，和界面「能力与记忆」一致。
import {listTools} from '../src/tools/registry.mjs';

const tools = listTools();
console.log('工具清单（R=只读，W=可写）\n' + '─'.repeat(72));
for (const t of tools) {
  console.log(`${t.permission === 'write' ? 'W' : 'R'}  ${t.name.padEnd(26)} ${t.title}  (${Math.round((t.timeoutMs || 10000) / 1000)}s)`);
  console.log(`   ${t.description}`);
}
console.log('─'.repeat(72));
console.log(`共 ${tools.length} 个工具，其中只读 ${tools.filter(t => t.permission !== 'write').length} 个。`);
