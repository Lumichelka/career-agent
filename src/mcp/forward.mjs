// 入站转发（#38）：把 /mcp 的上游工具接到该用户已启用外部 Agent 的连接上。
// 复用 #35 的 ExternalToolset：命名（mcp__<agent>__<tool>）、统一信封、错误码、证据与取消链都在那边，
// 这里只负责取到该用户的 Agent 配置/连接，并把来源标成 forwarded_client + client id。
// 首次出网确认不逐次弹：签发入站凭据就是对该用户可见工具的同意（凭据快照只做扩权提示，见 inbound.mjs）。
import {join} from 'node:path';
import {buildEnvelope, EXTERNAL_RECOVERY, EXTERNAL_PREFIX, ExternalToolset} from '../agents/tools.mjs';

export const FORWARD_ACTOR = 'forwarded_client';

// 转发证据：actorType/actorRef/clientId 必须能认出是哪个 client 发起的；不含上游凭据。
function tagged(envelope, {clientId = '', clientName = ''} = {}) {
  const evidence = {
    ...(envelope?.evidence || {}),
    actorType: FORWARD_ACTOR,
    actorRef: String(clientId || '')
  };
  if (clientId) evidence.clientId = String(clientId);
  if (clientName) evidence.clientName = String(clientName);
  return {...envelope, evidence};
}

function unsupported(message, clientId, clientName) {
  return tagged(buildEnvelope({
    status: 'error',
    error: {code: 'UNSUPPORTED', message, recovery: EXTERNAL_RECOVERY.UNSUPPORTED}
  }), {clientId, clientName});
}

export class InboundForwarder {
  constructor({dataDir, getTenant, emit = () => {}} = {}) {
    if (!dataDir || typeof getTenant !== 'function') throw new Error('InboundForwarder 需要 dataDir 与 getTenant');
    this.dataDir = dataDir;
    this.getTenant = getTenant;
    this.emit = emit;
  }

  async #toolset(userId, {clientId = '', clientName = ''} = {}) {
    const tenant = await this.getTenant(userId);
    if (!tenant) return null;
    const home = join(this.dataDir, 'users', String(userId));
    return new ExternalToolset({
      userId,
      taskId: '',
      home,
      // 转发调用的完整响应留在该用户自己的 inbound/evidence 下；模型/客户端只看信封。
      evidenceDir: join(home, 'inbound', 'evidence'),
      config: tenant.agents,
      connections: tenant.connections,
      refreshTools: true,
      askConsent: async () => ({decision: 'once'}),
      emit: this.emit,
      actorType: FORWARD_ACTOR,
      actorRef: String(clientId || ''),
      actorName: String(clientName || '')
    });
  }

  // 入站 ListTools 用：该用户所有启用 Agent 的工具（已按出站命名与 Agent 名排序）。
  async listTools(userId, options = {}) {
    const toolset = await this.#toolset(userId, options);
    if (!toolset) return {tools: [], agents: [], unavailable: []};
    const snapshot = await toolset.pin();
    return {tools: snapshot.tools, agents: snapshot.agents, unavailable: snapshot.unavailable};
  }

  async callTool({userId, clientId = '', clientName = '', name, args = {}, signal} = {}) {
    const wanted = String(name || '');
    if (!wanted.startsWith(EXTERNAL_PREFIX)) return unsupported('不是外部 Agent 工具：' + wanted, clientId, clientName);
    const toolset = await this.#toolset(userId, {clientId, clientName});
    if (!toolset) return unsupported('该凭据所属账号已不存在。', clientId, clientName);
    // 每次按当前工具面找描述符：入站不做任务内快照，上游新增工具对旧凭据立即可用。
    const snapshot = await toolset.pin();
    const descriptor = snapshot.tools.find(tool => tool.name === wanted) || null;
    if (!descriptor) {
      // 该 Agent 这一轮连不上：按 #35 的错误码回（CONNECT_FAILED / AUTH_FAILED / …），而不是笼统的未知工具。
      const down = (snapshot.unavailable || []).find(item => item.slug && wanted.startsWith(EXTERNAL_PREFIX + item.slug + '__'));
      if (down) {
        return tagged(buildEnvelope({
          status: 'error',
          error: {code: down.code, message: down.message, recovery: down.recovery},
          retryable: false
        }), {clientId, clientName});
      }
      return unsupported('当前可用工具里没有 ' + wanted + '：上游可能已移除该工具或该 Agent 已停用。', clientId, clientName);
    }
    const envelope = await toolset.callTool(descriptor, args, {signal});
    // 上游可能把某些字段原样带回来；信封统一再标一次来源，保证审计/证据能认出 client。
    return tagged(envelope, {clientId, clientName});
  }
}
