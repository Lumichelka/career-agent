import {requireBridge} from './util.mjs';

async function bridge(action, args, ctx) {
  const {base, token} = requireBridge(ctx.config);
  const r = await ctx.fetchImpl(base + '/api/platform/' + action, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': token},
    body: JSON.stringify({...args, taskId: ctx.taskId}),
    signal: ctx.signal
  });
  if (!r.ok) throw new Error('本机工具响应 HTTP ' + r.status);
  return r.json();
}

export const status = (args, ctx) => bridge('status', args, ctx);
export const search = (args, ctx) => bridge('search', args, ctx);
export const read = (args, ctx) => bridge('read', args, ctx);
