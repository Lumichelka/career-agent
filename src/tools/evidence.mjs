// 把工具结果收敛成一条任务证据：截图、页面原文、来源列表或数据条数。
// 证据跟着任务走，模型只看到工具结果本身；这里只挑可展示的元数据，不复制大段正文。
import {getTool} from './registry.mjs';

export function evidenceFromToolResult(toolName, value) {
  if (!value || typeof value !== 'object') return null;
  const status = String(value.status || '');
  if (['error', 'blocked', 'confirm_required', 'not_found', 'unavailable'].includes(status)) return null;
  const label = value.name || value.title || getTool(toolName)?.title || toolName || 'tool';
  const name = String(label).slice(0, 60);
  const summary = String(value.message || value.notice || status || '').replace(/\s+/g, ' ').slice(0, 160);
  const at = new Date().toISOString();
  if (typeof value.screenshotUrl === 'string' && value.screenshotUrl) {
    return {kind: 'screenshot', name, summary, url: value.screenshotUrl, at};
  }
  if (typeof value.text === 'string' && value.text.trim()) {
    return {kind: 'page', name, summary, bytes: Buffer.byteLength(value.text, 'utf8'), at};
  }
  if (Array.isArray(value.sources) && value.sources.length) {
    return {kind: 'source', name, summary, count: value.sources.length, at};
  }
  if (Array.isArray(value.projects) && value.projects.length) {
    return {kind: 'data', name, summary, count: value.projects.length, at};
  }
  if (Array.isArray(value.events) && value.events.length) {
    return {kind: 'data', name, summary, count: value.events.length, at};
  }
  return {kind: 'tool', name, summary, at};
}
