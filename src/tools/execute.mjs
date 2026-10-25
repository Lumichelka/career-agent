// 工具执行：统一校验 → 去重 → 权限 → 超时 → 分发。
import {getTool} from './registry.mjs';
import {validateArguments} from './policy.mjs';
import * as recruit from './handlers/recruit.mjs';
import * as search from './handlers/search.mjs';
import * as platform from './handlers/platform.mjs';
import * as resume from './handlers/resume.mjs';
import * as interview from './handlers/interview.mjs';
import * as company from './handlers/company.mjs';
import * as profile from './handlers/profile.mjs';

export const HANDLERS = {
  'recruit.events': recruit.events,
  'recruit.projects': recruit.projects,
  'recruit.project': recruit.project,
  'recruit.sources': recruit.sourceStates,
  'recruit.bulkWrite': recruit.bulkWrite,
  'profile.write': profile.profileWrite,
  'search.public': search.publicSearch,
  'search.company': search.companyResearch,
  'platform.status': platform.status,
  'platform.search': platform.search,
  'platform.read': platform.read,
  'resume.list': resume.list,
  'resume.read': resume.read,
  'interview.list': interview.list,
  'interview.read': interview.read,
  'company.list': company.list,
  'company.read': company.read
};

export function createToolExecutor({runner = null} = {}) {
  const seen = new Map();
  return async function execute(name, rawArgs, ctx = {}) {
    const tool = getTool(name);
    if (!tool) return {status: 'error', code: 'UNKNOWN_TOOL', message: '工具未开放', recovery: '只使用已声明的工具。'};
    let args;
    try { args = validateArguments(tool, rawArgs); }
    catch (e) { return {status: 'error', code: 'INVALID_ARGUMENTS', message: e.message, recovery: '根据工具声明修正参数后重试。'}; }
    const key = JSON.stringify([name, args]);
    if (seen.has(key)) {
      return {status: 'blocked', code: 'DUPLICATE_CALL', message: '本次任务已执行过相同请求，未再次访问平台。', previousStatus: seen.get(key), recovery: '使用先前结果；无结果时更换关键词或说明所需操作，不要原样重试。'};
    }
    // 写工具的确认由写网关按 sensitivity 判定（auto 直接写、sensitive 返回 confirm_required）；
    // 只有没有声明 sensitivity 的旧写工具仍沿用 ctx.confirmed 这一道。
    if (tool.permission === 'write' && !tool.sensitivity && !ctx.confirmed) {
      return {status: 'confirm_required', code: 'NEEDS_CONFIRMATION', message: '该工具会写入数据，需要用户确认后执行。'};
    }
    const handler = runner || HANDLERS[tool.handler];
    if (!handler) return {status: 'error', code: 'MISSING_HANDLER', message: '工具没有实现'};
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, tool.timeoutMs || 15000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    try {
      const result = runner ? await runner(tool, args, {...ctx, signal}) : await handler(args, {...ctx, signal});
      seen.set(key, result?.status || 'returned');
      return result;
    } catch (e) {
      const result = {
        status: 'error',
        code: timedOut ? 'TIMEOUT' : 'TOOL_FAILED',
        message: timedOut ? '工具超过 ' + Math.round((tool.timeoutMs || 15000) / 1000) + ' 秒未返回' : e.message,
        recovery: '检查错误原因，换用可用来源或说明尚未完成的部分。'
      };
      seen.set(key, result.status);
      return result;
    } finally { clearTimeout(timer); }
  };
}

// 直接调用（无去重/超时），给命令行与测试用
export async function callTool(name, args, ctx = {}) {
  const tool = getTool(name);
  if (!tool) throw new Error('工具未开放');
  const handler = HANDLERS[tool.handler];
  if (!handler) throw new Error('工具没有实现');
  return handler(validateArguments(tool, args), ctx);
}
