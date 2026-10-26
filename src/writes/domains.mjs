// 自动写入域：每个域一个 SQLite 库，业务表与审计四张表同库同事务。
import {getTool} from '../tools/registry.mjs';

export const WRITE_DOMAINS = [
  {domain: 'recruit', file: 'recruit.db'},
  {domain: 'profile', file: 'profile.db'}
];

export function domainEntry(domain) {
  return WRITE_DOMAINS.find(entry => entry.domain === String(domain || '')) || null;
}

export function domainForTool(toolName) {
  const tool = getTool(toolName);
  if (!tool || !tool.writeDomain) return null;
  return domainEntry(tool.writeDomain);
}
