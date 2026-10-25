// /api/agents：外部 Agent 配置 CRUD、测试连接、刷新工具、重连。
// 身份只来自登录 cookie（app.mjs 完成认证）；每个请求都只作用在当前用户自己的配置与连接上。
import {AgentConfigError} from './config.mjs';
import {AgentConnectionError} from '../mcp/client.mjs';

function fail(error) {
  const status = Number(error?.status) || 400;
  return {status, json: {error: error?.message || String(error), code: error?.code || 'AGENT_ERROR'}};
}

function publicById(agents, id) {
  return agents.list().find(agent => agent.id === id) || null;
}

function requireId(body, url) {
  const id = String(body?.id || url?.searchParams?.get('id') || '').trim();
  if (!id) throw new AgentConfigError('MISSING_AGENT_ID', '缺少 Agent id');
  return id;
}

// 公开配置 + 连接状态拍平：界面与测试都读 agent.state / era / tools / lastError。
function withStatus(agent, status) {
  return {...agent, ...(status || {}), status: status || null, state: status?.state || 'disconnected'};
}

export async function handleAgents({method, pathname, url, body = {}, user, agents, connections}) {
  if (!String(pathname || '').startsWith('/api/agents')) return null;
  const isOwner = user?.name === 'owner';
  const route = String(pathname).slice('/api/agents'.length).replace(/\/$/, '');

  try {
    if (route === '' || route === '/') {
      if (method === 'GET') {
        const statuses = new Map((await connections.statuses()).map(status => [status.id, status]));
        return {
          status: 200,
          json: {
            owner: isOwner,
            max: 10,
            transports: isOwner ? ['stdio', 'http'] : ['http'],
            agents: agents.list().map(agent => withStatus(agent, statuses.get(agent.id)))
          }
        };
      }
      if (method === 'POST') {
        const agent = await agents.create(body || {}, {isOwner});
        return {status: 200, json: {agent: withStatus(agent, await connections.status(agent.id))}};
      }
      if (method === 'PATCH') {
        const id = requireId(body, url);
        const agent = await agents.update(id, body || {}, {isOwner});
        // 配置变了就丢掉旧连接：地址、凭据、启停都可能影响下一次连接。
        await connections.disconnect(id, 'config-changed').catch(() => {});
        return {status: 200, json: {agent: withStatus(agent, await connections.status(agent.id))}};
      }
      if (method === 'DELETE') {
        const id = requireId(body, url);
        await agents.remove(id);
        await connections.forget(id).catch(() => {});
        return {status: 200, json: {ok: true, id}};
      }
      return {status: 405, json: {error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED'}};
    }

    if (method !== 'POST') return {status: 405, json: {error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED'}};
    if (!['/test', '/refresh', '/reconnect'].includes(route)) return null;
    const id = requireId(body, url);
    const before = publicById(agents, id);
    if (!before) throw new AgentConfigError('AGENT_NOT_FOUND', '没有这个外部 Agent', 404);

    // 连接失败不是 HTTP 错误：200 + 失败状态，界面照常渲染错误码与恢复建议。
    try {
      if (route === '/test') await connections.test(id);
      else if (route === '/refresh') await connections.refresh(id);
      else await connections.reconnect(id);
      const status = await connections.status(id);
      return {status: 200, json: {ok: true, agent: withStatus(publicById(agents, id), status)}};
    } catch (error) {
      const status = await connections.status(id).catch(() => null);
      return {
        status: 200,
        json: {
          ok: false,
          code: error?.code || 'CONNECT_FAILED',
          error: error?.message || String(error),
          recovery: error?.recovery || '',
          agent: withStatus(publicById(agents, id), status)
        }
      };
    }
  } catch (error) {
    if (error instanceof AgentConfigError || error instanceof AgentConnectionError) return fail(error);
    throw error;
  }
}
