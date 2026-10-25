// 把工具结果收敛成一条任务证据：截图、页面原文、来源列表或数据条数。
// 证据跟着任务走，模型只看到工具结果本身；这里只挑可展示的元数据，不复制大段正文。
import {getTool} from './registry.mjs';

export function evidenceFromToolResult(toolName, value) {
  if (!value || typeof value !== 'object') return null;
  const status = String(value.status || '');
  if (['error', 'blocked', 'confirm_required', 'not_found', 'unavailable'].includes(status)) return null;
  const tool = getTool(toolName);
  const label = value.name || value.title || tool?.title || toolName || 'tool';
  const name = String(label).slice(0, 60);
  const summary = String(value.message || value.notice || status || '').replace(/\s+/g, ' ').slice(0, 160);
  const at = new Date().toISOString();
  if (typeof value.screenshotUrl === 'string' && value.screenshotUrl) {
    return {kind: 'screenshot', name, summary, url: value.screenshotUrl, at};
  }
  // 只有平台读取/搜索（或 Codex 这类未注册工具）的正文才算「页面原文」；别的工具字段叫 text 也不当证据。
  if (typeof value.text === 'string' && value.text.trim() && (!tool || String(tool.handler).startsWith('platform.'))) {
    return {kind: 'page', name, summary, bytes: Buffer.byteLength(value.text, 'utf8'), at};
  }
  const sources = Array.isArray(value.sources) ? value.sources : Array.isArray(value.results) ? value.results : null;
  if (sources?.length) return {kind: 'source', name, summary, count: sources.length, at};
  const rows = Array.isArray(value.projects) ? value.projects : Array.isArray(value.events) ? value.events : null;
  if (rows?.length) return {kind: 'data', name, summary, count: rows.length, at};
  // 其余成功调用（写操作、记忆、状态查询）不是证据；任务卡不把它们算进去。
  return null;
}
