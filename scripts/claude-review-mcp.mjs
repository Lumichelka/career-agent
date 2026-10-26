// 轻量 MCP 复核桥：把 Claude Code CLI 包装成一个只读、收 prompt、返回文本的 MCP 工具。
// 只用于 live 首验的外部 Agent 复核；不暴露任何写工具，Claude 进程也以 --tools "" 启动。
import {Server} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {execFile} from 'node:child_process';

const SYSTEM = '你是来源校对任务里的独立文本复核员。只做文本复核：不读图、不调用工具、不修改文件、不写入任何数据。只输出 JSON，不要解释。格式：{"issues":[{"row":"events[0]","field":"title","issue":"……","severity":"high|medium|low"}]}。没有问题输出 {"issues":[]}。不要给出修改后的数据。';

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', prompt, '--output-format', 'text', '--tools', '', '--append-system-prompt', SYSTEM], {
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || 'claude failed').slice(0, 800)));
      else resolve(String(stdout || '').trim());
    });
  });
}

function server() {
  const s = new Server({name: 'claude-review-bridge', version: '1.0.0'}, {capabilities: {tools: {}}});
  s.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: 'review',
      description: '只读文本复核：接收抽取 JSON 与来源元数据，只返回问题列表 JSON。',
      inputSchema: {type: 'object', properties: {prompt: {type: 'string', description: '复核提示词'}}, required: ['prompt'], additionalProperties: false},
      annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}
    }]
  }));
  s.setRequestHandler('tools/call', async request => {
    const prompt = String(request.params?.arguments?.prompt || '');
    if (!prompt.trim()) return {content: [{type: 'text', text: '{"issues":[]}'}]};
    const text = await runClaude(prompt);
    return {content: [{type: 'text', text}]};
  });
  return s;
}

serveStdio(server);
