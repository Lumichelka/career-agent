import {Accounts} from './accounts.mjs';
import {ModelSettings, validateModelSettings} from '../model/model-settings.mjs';
import {presetOptions, decorateChatError} from '../model/providers.mjs';
import {BACKEND_CHOICES, MAX_IMAGE_BYTES, BackendChoice, isImageAttachment, normalizeImageAttachment, publicBackends, resolveTurn, selectBackend, suggestFallback} from '../model/backends.mjs';
import {runApiModel, probeApi} from '../model/api-model.mjs';
import {runDiagnostics} from '../model/diag.mjs';
import {KeyVault} from '../model/keyvault.mjs';
import {PlatformBrowser} from '../platform/platforms.mjs';
import {PLATFORM_SITES} from '../platform/sites.mjs';
import {handleRecruit} from '../recruit/api.mjs';
import {handleResume} from '../resume/api.mjs';
import {handleCompany} from '../company/api.mjs';
import {handleWechat} from '../wechat/api.mjs';
import http from 'node:http';
import os from 'node:os';
import {readFile, mkdir, writeFile, readdir, copyFile, unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {runAgent, runModel} from '../agent/agent.mjs';
import {listTools} from '../tools/registry.mjs';
import {TaskManager, TaskGate} from './tasks.mjs';
import {createToolExecutor} from '../tools/execute.mjs';
import {InboundMcp} from '../mcp/inbound.mjs';
import {createInboundHttp} from './inbound-http.mjs';
import {AgentConfig} from '../agents/config.mjs';
import {AgentConnectionManager, createSdkConnection} from '../mcp/client.mjs';
import {handleAgents} from '../agents/api.mjs';
import {handleAudit} from '../writes/audit-api.mjs';
import {acceptConfirmation, listConfirmations, rejectConfirmation} from '../writes/confirmations.mjs';
import {listSkills, selectSkill} from '../skills/index.mjs';
import {memorySummary, buildMemoryPayload, addFact, deleteFact, clearProfile, importSessionMemory, loadProfile, recordTask, clearTasks} from '../agent/memory.mjs';

// 应用工厂：装配一个可启动的实例，不做进程级的事（环境变量、日志格式归 index.mjs）。
// 返回 {server, token, dataDir, host, port, origin, close}；port 传 0 时由系统分配，close 幂等。
export async function createApp({
  dataDir,
  root = fileURLToPath(new URL('../..', import.meta.url)),
  host = '127.0.0.1',
  port = 0,
  taskLimits = {},
  // 测试注入：外部 Agent 连接用假 transport，绝不启动真实进程或联网；时钟可注入以验证空闲回收。
  agentClientFactory = null,
  agentNow = null
} = {}) {
if (!dataDir) throw new Error('createApp 需要 dataDir：准备数据目录是进程级入口（index.mjs）的职责');
await mkdir(dataDir, {recursive: true});
const tokenFile = join(dataDir, 'local-session-token');
let token = await readFile(tokenFile, 'utf8').catch(() => '');
if (!/^[a-f0-9]{48}$/.test(token)) { token = randomBytes(24).toString('hex'); await writeFile(tokenFile, token, 'utf8'); }
const running = new Map(), taskEvents = new Map(), loginWaiters = new Map(), loginPrompted = new Set();
// 服务端兜底的连续失败计数：客户端不老实递增 fallbackDepth 时，换后端建议仍然封顶 3 次。
const failureStreaks = new Map();
// 任务闸与任务记录：每用户 2 / 全局 8 / 排队 120s；记录落在 users/<id>/tasks/，供抽屉刷新。
const taskManager = new TaskManager({dataDir, gate: new TaskGate(taskLimits), maxDurationMs: taskLimits.maxDurationMs});
let actualPort = Number(port);
let localOrigin = 'http://127.0.0.1:' + actualPort;
let allowedHosts = new Set();
// 多设备访问：默认只监听本机；CAREER_HOST=0.0.0.0 时开放局域网，但保留口令与账号两道门槛。
function buildAllowedHosts(listenPort) {
  const set = new Set(['127.0.0.1:' + listenPort, 'localhost:' + listenPort, '[::1]:' + listenPort, '127.0.0.1', 'localhost']);
  if (host !== '127.0.0.1') {
    for (const list of Object.values(os.networkInterfaces())) for (const net of list || []) if (net.family === 'IPv4' && !net.internal) { set.add(net.address + ':' + listenPort); set.add(net.address); }
  }
  for (const extra of String(process.env.CAREER_ALLOWED_HOSTS || '').split(',')) { const h = extra.trim(); if (h) { set.add(h); set.add(h + ':' + listenPort); } }
  return set;
}
const hostAllowed = h => !!h && (allowedHosts.has(h) || allowedHosts.has(h.split(':')[0]));

const accounts = await new Accounts(dataDir).init(), tenants = new Map(), owners = new Map(), bridgeTokens = new Map();
// Existing local records belong only to a generated owner account.
if (!accounts.users.length) {
  const password = randomBytes(15).toString('base64url'); const owner = await accounts.register('owner', password);
  const target = join(dataDir, 'users', owner.id, '.data'); await mkdir(target, {recursive: true});
  for (const name of await readdir(dataDir)) { if (/^[a-f0-9-]{36}\.json$/.test(name) || name === 'model-settings.json') await copyFile(join(dataDir, name), join(target, name)); }
  await writeFile(join(dataDir, '首次登录.txt'), '账号：owner\n密码：' + password + '\n请勿把本文件或.data文件夹分享给别人。', 'utf8');
}
async function tenant(user) {
  if (!tenants.has(user.id)) tenants.set(user.id, (async () => {
    const home = join(dataDir, 'users', user.id);
    const tenantData = join(home, '.data');
    await mkdir(tenantData, {recursive: true});
    const vault = await new KeyVault(tenantData).init();
    const model = await new ModelSettings(home, vault).load();
    model.allowEnvironmentKey = false; // 不继承服务器环境变量里的 Key，避免账号之间串用
    const backends = await new BackendChoice(tenantData).load();
    const agentConfig = await new AgentConfig(home, vault).load();
    const managerOptions = {home, config: agentConfig};
    if (agentClientFactory) managerOptions.createConnection = agentClientFactory;
    else managerOptions.createConnection = createSdkConnection;
    if (agentNow) managerOptions.now = agentNow;
    return {dir: tenantData, models: model, backends, platforms: new PlatformBrowser(home), vault, agents: agentConfig, connections: new AgentConnectionManager(managerOptions)};
  })());
  return tenants.get(user.id);
}
// 入站 /mcp：身份只来自自签 bearer，调用落到凭据所属账号的租户目录。
const inboundMcp = await new InboundMcp({
  dataDir,
  accounts,
  getOrigin: () => localOrigin,
  callTool: async ({userId, name, args}) => {
    const user = accounts.users.find(u => u.id === userId);
    if (!user) return {status: 'error', code: 'ACCOUNT_MISSING', message: '该凭据所属账号已不存在', recovery: '请重新登录网页端并重新签发凭据。'};
    const t = await tenant(user);
    const model = t.models.snapshot();
    return createToolExecutor()(name, args, {
      taskId: '',
      config: {searchUrl: model.searchUrl, recruitDir: t.dir, dataDir: t.dir},
      fetchImpl: fetch,
      signal: AbortSignal.timeout(180000)
    });
  }
}).init();
const send = (res, obj, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); };
const sendFile = (res, body, type, name) => { res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', ...(name ? {'Content-Disposition': 'attachment; filename="' + name + '"'} : {})}); res.end(body); };
const inboundHttp = createInboundHttp({inbound: inboundMcp, send});
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const file = (dir, id) => join(dir, id + '.json');
async function load(dir, id) { if (!validId(id)) throw new Error('无效会话'); return JSON.parse(await readFile(file(dir, id), 'utf8')); }
async function save(dir, s) { await writeFile(file(dir, s.id), JSON.stringify(s, null, 2), 'utf8'); }

async function platformReadForTask(platforms, action, body) {
  const execute = () => action === 'search' ? platforms.search(body.platform, body.query) : action === 'open-result' ? platforms.openResult(body.platform) : platforms.read(body.platform);
  const result = await execute();
  const emit = taskEvents.get(body.taskId), controller = running.get(body.taskId), key = body.taskId + ':' + body.platform;
  if (!emit || !controller || !['needs_connection', 'needs_login', 'needs_user', 'needs_verification', 'unconfirmed', 'load_failed'].includes(result.status) || loginPrompted.has(key)) return result;
  loginPrompted.add(key);
  emit({type: 'platform_required', platform: body.platform, platformName: PLATFORM_SITES[body.platform]?.name || body.platform, reason: result.message, taskId: body.taskId});
  const choice = await new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); loginWaiters.delete(body.taskId); resolve(value); };
    const abort = () => finish('cancel');
    const timer = setTimeout(() => finish('timeout'), 300000);
    loginWaiters.set(body.taskId, finish); controller.signal.addEventListener('abort', abort, {once: true}); if (controller.signal.aborted) abort();
  });
  emit({type: 'platform_resolved', platform: body.platform});
  if (choice === 'resume') return execute();
  return {...result, message: choice === 'skip' ? '用户选择暂不登录。请说明缺少平台来源，使用公开资料完成可行部分。' : choice === 'timeout' ? '等待本人登录超时，本次未取得平台资料。' : '用户已停止任务。'};
}

const server = http.createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host || '';
    if (!hostAllowed(hostHeader)) return send(res, {error: 'Host rejected'}, 403);
    const requestOrigin = 'http://' + hostHeader;
    const url = new URL(req.url, requestOrigin);

    if (req.method === 'GET' && url.pathname === '/health') return send(res, {app: 'career-agent', status: 'ready', host, port: actualPort});

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, {Location: '/chat'});
      return res.end();
    }

    if (req.method === 'GET' && ['/today', '/index.html'].includes(url.pathname)) {
      const html = (await readFile(join(root, 'src', 'web', 'workbench.html'), 'utf8')).replaceAll('SESSION_TOKEN', token);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src 'self' https://esm.sh; worker-src blob: https://esm.sh; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff'});
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/chat') {
      const html = (await readFile(join(root, 'src', 'web', 'index.html'), 'utf8')).replace('SESSION_TOKEN', token);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src 'self' https://esm.sh; worker-src blob: https://esm.sh; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff'});
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/recruit') {
      const html = (await readFile(join(root, 'src', 'web', 'recruit.html'), 'utf8')).replaceAll('SESSION_TOKEN', token);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff'});
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/resume') {
      const html = (await readFile(join(root, 'src', 'web', 'resume.html'), 'utf8')).replaceAll('SESSION_TOKEN', token);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff'});
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/wechat') {
      res.writeHead(302, {Location: '/recruit?tab=sources&type=wechat'});
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/companies') {
      res.writeHead(302, {Location: '/chat'});
      return res.end();
    }

    if (req.method === 'GET' && ['/ui-model.js', '/inbound.js', '/capabilities.js', '/memory.js', '/artifact.js', '/workflow.js', '/backends.js', '/agents.js', '/vendor/mammoth.js', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs'].includes(url.pathname)) {
      const assets = {'/ui-model.js': 'src/web/ui-model.js', '/inbound.js': 'src/web/inbound.js', '/capabilities.js': 'src/web/capabilities.js', '/memory.js': 'src/web/memory.js', '/artifact.js': 'src/web/artifact.js', '/workflow.js': 'src/web/workflow.js', '/backends.js': 'src/web/backends.js', '/agents.js': 'src/web/agents.js', '/vendor/mammoth.js': 'node_modules/mammoth/mammoth.browser.min.js', '/vendor/pdf.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', '/vendor/pdf.worker.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'};
      const content = await readFile(join(root, assets[url.pathname]));
      res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
      return res.end(content);
    }

    // 跨站请求防护：Origin 必须与当前访问地址一致
    if (req.headers.origin && req.headers.origin !== requestOrigin && req.headers.origin !== localOrigin) return send(res, {error: 'Origin rejected'}, 403);

    // 对外 MCP 入站：现有端口上的 /mcp，自带 bearer 鉴权，不走网页会话口令。
    // 开关关闭时端点就是不存在（404）；实例口令与登录 cookie 在这里都不是身份。
    if (url.pathname === '/mcp') return inboundHttp(req, res, url, localOrigin);

    if (req.headers['x-career-token'] !== token && !bridgeTokens.has(req.headers['x-career-token'])) return send(res, {error: '会话校验失败，请刷新页面'}, 403);

    if (req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(url.pathname)) {
      let raw = '';
      for await (const b of req) { raw += b; if (raw.length > 2048) return send(res, {error: '请求过长'}, 413); }
      const b = JSON.parse(raw || '{}');
      if (url.pathname.endsWith('/register')) await accounts.register(b.name, b.password);
      const login = accounts.login(b.name, b.password);
      res.setHeader('Set-Cookie', 'career_auth=' + login.token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
      return send(res, {user: login.user});
    }

    let user = accounts.authenticate(req.headers.cookie);
    // The model bridge may only access the tenant of a currently running task.
    if (!user && req.method === 'POST' && ['/api/platform/status', '/api/platform/search', '/api/platform/read'].includes(url.pathname)) {
      let raw = '';
      for await (const b of req) { raw += b; if (raw.length > 4096) return send(res, {error: '请求过长'}, 413); }
      const b = JSON.parse(raw || '{}');
      user = owners.get(b.taskId);
      if (bridgeTokens.get(req.headers['x-career-token']) !== b.taskId || !user || !running.has(b.taskId)) return send(res, {error: '任务无权访问'}, 403);
      const t = await tenant(user);
      return send(res, url.pathname.endsWith('/status') ? {platforms: await t.platforms.statuses()} : await platformReadForTask(t.platforms, url.pathname.split('/').pop(), b));
    }
    if (!user) return send(res, {error: '请先登录自己的测试账号'}, 401);

    const {dir, models, backends, platforms, agents, connections} = await tenant(user);

    if (url.pathname === '/api/auth/me') return send(res, {user: {name: user.name, id: user.id}});
    if (req.method === 'GET' && url.pathname.startsWith('/api/platform/screenshot/')) {
      const id = url.pathname.split('/').pop();
      try {
        const image = await readFile(platforms.screenshotPath(id));
        res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'});
        return res.end(image);
      } catch {
        return send(res, {error: '还没有该网站的截图'}, 404);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      accounts.logout(req.headers.cookie);
      res.setHeader('Set-Cookie', 'career_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return send(res, {ok: true});
    }
    if (req.method === 'GET' && url.pathname === '/api/model') return send(res, models.public());
    if (req.method === 'GET' && url.pathname === '/api/backends') {
      return send(res, publicBackends({settings: models.public(), choice: backends, user}));
    }
    if (req.method === 'GET' && url.pathname === '/api/model/presets') return send(res, {presets: presetOptions()});
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const sessionId = url.searchParams.get('session') || '';
      let session = null;
      if (sessionId) { try { session = await load(dir, sessionId); } catch { session = null; } }
      return send(res, await buildMemoryPayload(dir, session));
    }
    if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(res, {tools: listTools(), skills: await listSkills(root), memory: await memorySummary(dir)});
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      return send(res, await taskManager.summary(user.id, {sessionId: url.searchParams.get('session') || undefined}));
    }
    // 自动写入审计：只读当前用户自己的库；按任务/批次分组，响应形状供审阅层（#31/#41）复用。
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const out = await handleAudit({dir, userId: user.id, url});
      return send(res, out.json);
    }
    // 敏感写入的挂起确认：默认只列本人未处理、未过期的；state=all 供任务卡审计区看已接受/已拒绝记录。
    if (req.method === 'GET' && url.pathname === '/api/confirmations') {
      const out = listConfirmations({
        dir,
        userId: user.id,
        taskId: String(url.searchParams.get('taskId') || '').trim(),
        state: url.searchParams.get('state') === 'all' ? 'all' : 'pending',
        limit: Number(url.searchParams.get('limit')) || 50
      });
      return send(res, out);
    }
    if (req.method === 'GET' && url.pathname === '/api/mcp') return send(res, (await inboundMcp.status(user.id)).json);
    // 外部 Agent：配置、连接状态与工具列表；全部作用在当前登录用户自己的 users/<id>/.data 上。
    if (req.method === 'GET' && ['/api/agents', '/api/agents/'].includes(url.pathname)) {
      const t = await tenant(user);
      const out = await handleAgents({method: 'GET', pathname: '/api/agents', url, user, agents: t.agents, connections: t.connections});
      return send(res, out.json, out.status);
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const items = [];
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const s = JSON.parse(await readFile(join(dir, name), 'utf8'));
          // 目录里还有模型配置、密钥等文件，只认真正的会话记录
          if (typeof s?.id !== 'string' || !validId(s.id) || typeof s.title !== 'string' || typeof s.updatedAt !== 'string') continue;
          items.push({id: s.id, title: s.title, updatedAt: s.updatedAt});
        } catch { /* 跳过损坏记录 */ }
      }
      return send(res, {sessions: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) return send(res, await load(dir, url.pathname.split('/').pop()));

    if (req.method === 'GET' && (url.pathname.startsWith('/api/resumes') || url.pathname.startsWith('/api/applications') || url.pathname.startsWith('/api/interviews'))) {
      const out = await handleResume({method: 'GET', pathname: url.pathname.slice('/api/'.length), url, dir});
      if (!out) return send(res, {error: '未知的简历接口'}, 404);
      if (out.file) return sendFile(res, out.file.body, out.file.type, out.file.name);
      return send(res, out.json, out.status || 200);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/wechat')) {
      const out = await handleWechat({method: 'GET', pathname: url.pathname.slice('/api/wechat/'.length), url, dir});
      if (!out) return send(res, {error: '未知的公众号接口'}, 404);
      return send(res, out.json, out.status || 200);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/companies')) {
      const out = await handleCompany({method: 'GET', pathname: url.pathname.slice('/api/'.length), dir});
      if (!out) return send(res, {error: '未知的公司档案接口'}, 404);
      return send(res, out.json, out.status || 200);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/recruit/')) {
      const out = await handleRecruit({method: 'GET', pathname: url.pathname.slice('/api/recruit/'.length), url, dir});
      if (!out) return send(res, {error: '未知的招聘信息接口'}, 404);
      if (out.file) return sendFile(res, out.file.body, out.file.type, out.file.name);
      return send(res, out.json, out.status || 200);
    }

    // Agent 配置的局部更新与删除：PATCH / DELETE 与 POST 共用同一个请求体上限。
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      let raw = '';
      for await (const b of req) { raw += b.toString(); if (raw.length > 400000) return send(res, {error: '本次资料过多，请分批发送'}, 413); }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, {error: '请求体不是合法 JSON', code: 'INVALID_JSON'}, 400); }
      const t = await tenant(user);
      const out = await handleAgents({method: req.method, pathname: url.pathname, url, body, user, agents: t.agents, connections: t.connections});
      if (!out) return send(res, {error: 'Not found'}, 404);
      return send(res, out.json, out.status);
    }

    if (req.method === 'POST') {
      let raw = '';
      // 聊天允许带图片：base64 后约 10.7MB；其他接口维持原有 400KB 上限。
      const bodyLimit = url.pathname === '/api/chat' ? 12 * 1024 * 1024 : 400000;
      for await (const b of req) { raw += b.toString(); if (raw.length > bodyLimit) return send(res, {error: '本次资料过多，请分批发送'}, 413); }
      const body = JSON.parse(raw || '{}');

      if (url.pathname.startsWith('/api/agents')) {
        const out = await handleAgents({method: 'POST', pathname: url.pathname, url, body, user, agents, connections});
        if (!out) return send(res, {error: 'Not found'}, 404);
        return send(res, out.json, out.status);
      }

      // 入站 /mcp 的开关与 client 凭据：任何登录用户都能开，但开启要二次确认。
      if (url.pathname === '/api/mcp/switch') {
        const out = await inboundMcp.setEnabled({enabled: body.enabled, confirm: body.confirm === true, user});
        return send(res, out.json, out.status);
      }
      if (url.pathname === '/api/mcp/clients') {
        const out = await inboundMcp.issueClient({userId: user.id, name: body.name});
        return send(res, out.json, out.status);
      }
      if (url.pathname === '/api/mcp/clients/revoke') {
        const out = await inboundMcp.revokeClient({userId: user.id, id: String(body.id || '')});
        return send(res, out.json, out.status);
      }
      if (url.pathname === '/api/mcp/clients/regenerate') {
        const out = await inboundMcp.regenerateClient({userId: user.id, id: String(body.id || '')});
        return send(res, out.json, out.status);
      }

      // 接受/拒绝敏感写入确认：身份只来自当前登录用户；确认不属于本人时按不存在处理。
      if (url.pathname === '/api/confirmations/accept' || url.pathname === '/api/confirmations/reject') {
        const confirmId = String(body.confirmId || '').trim();
        if (!confirmId) return send(res, {error: '缺少 confirmId', code: 'INVALID_ARGUMENTS'}, 400);
        try {
          const accepted = url.pathname.endsWith('/accept');
          const out = accepted
            ? await acceptConfirmation({dir, userId: user.id, confirmId})
            : await rejectConfirmation({dir, userId: user.id, confirmId, reason: body.reason});
          // 接受时把真实写入条数并进任务卡；没有剩余待确认时才把任务从 waiting_confirmation 收尾。
          if (out.ok && out.taskId) {
            const left = listConfirmations({dir, userId: user.id, taskId: out.taskId, state: 'pending'});
            out.task = await taskManager.applyConfirmation(user.id, out.taskId, {
              state: 'succeeded',
              phase: accepted ? '确认已接受，写入完成' : '确认已拒绝，未写入',
              counts: accepted && !out.duplicate ? out.counts : null,
              finalize: !left.confirmations.length
            });
          }
          return send(res, out);
        } catch (error) {
          if (error && typeof error.status === 'number' && error.code) {
            // 过期确认无法再处理：把还停在待确认的任务收尾为失败，恢复建议是重新发起。
            if (error.status === 410 && error.taskId) {
              const left = listConfirmations({dir, userId: user.id, taskId: error.taskId, state: 'pending'});
              if (!left.confirmations.length) {
                await taskManager.applyConfirmation(user.id, error.taskId, {
                  state: 'failed', phase: '确认已过期',
                  error: {code: 'CONFIRMATION_EXPIRED', message: '这次确认已过期（10 分钟），写入没有执行。', recovery: '重新发起写入并确认。'}
                });
              }
            }
            return send(res, {error: error.message, code: error.code}, error.status);
          }
          throw error;
        }
      }

      if (url.pathname.startsWith('/api/recruit/')) {
        const out = await handleRecruit({method: 'POST', pathname: url.pathname.slice('/api/recruit/'.length), url, body, dir});
        if (!out) return send(res, {error: '未知的招聘信息接口'}, 404);
        if (out.file) return sendFile(res, out.file.body, out.file.type, out.file.name);
        return send(res, out.json, out.status || 200);
      }

      if (url.pathname === '/api/memory/profile') return send(res, {facts: await addFact(dir, body)});
      if (url.pathname === '/api/memory/profile/import') {
        const target = await load(dir, body.sessionId);
        return send(res, {facts: await importSessionMemory(dir, {sessionMemory: target.memory, sessionId: target.id})});
      }
      if (url.pathname === '/api/memory/profile/delete') return send(res, {facts: await deleteFact(dir, body.id)});
      if (url.pathname === '/api/memory/profile/clear') return send(res, {facts: await clearProfile(dir)});
      if (url.pathname === '/api/memory/tasks/clear') { await clearTasks(dir); return send(res, {ok: true}); }
      if (url.pathname.startsWith('/api/resumes') || url.pathname.startsWith('/api/applications') || url.pathname.startsWith('/api/interviews')) {
        const out = await handleResume({method: 'POST', pathname: url.pathname.slice('/api/'.length), url, body, dir});
        if (!out) return send(res, {error: '未知的简历接口'}, 404);
        if (out.file) return sendFile(res, out.file.body, out.file.type, out.file.name);
        return send(res, out.json, out.status || 200);
      }
      if (url.pathname.startsWith('/api/wechat')) {
        const out = await handleWechat({method: 'POST', pathname: url.pathname.slice('/api/wechat/'.length), body, dir});
        if (!out) return send(res, {error: '未知的公众号接口'}, 404);
        return send(res, out.json, out.status || 200);
      }
      if (url.pathname.startsWith('/api/companies')) {
        const out = await handleCompany({method: 'POST', pathname: url.pathname.slice('/api/'.length), body, dir});
        if (!out) return send(res, {error: '未知的公司档案接口'}, 404);
        return send(res, out.json, out.status || 200);
      }
      if (url.pathname === '/api/backends/select') {
        const out = await selectBackend({settings: models.public(), choice: backends, user, kind: String(body.kind || '')});
        if (!out.ok) return send(res, {error: out.message, code: out.code, configTarget: out.configTarget || ''}, out.status);
        return send(res, {ok: true, current: out.current, choices: out.choices, nextTurn: true});
      }
      // 「换 X 重试」的一次点击：建议必须绑定在刚刚失败的那张任务卡上，且只能消费一次。
      // 这里只切换后端并返回；重跑整轮由客户端拿着同一条消息/附件重新提交 /api/chat（带 fallbackDepth）。
      if (url.pathname === '/api/backends/fallback') {
        const taskId = String(body.taskId || '');
        const kind = String(body.kind || '');
        const check = await taskManager.checkFallback(user.id, {taskId, kind});
        if (!check.ok) {
          const messages = {
            missing: '没有这个任务', 'no-suggestion': '这条任务没有可用的回退建议',
            'not-failed': '任务没有失败，不需要回退', consumed: '这条建议已经用过了',
            'depth-limit': '换后端建议已用满 3 次', 'kind-mismatch': '建议的后端与这次点击不一致'
          };
          return send(res, {error: messages[check.reason] || '这条回退建议不可用', code: 'FALLBACK_' + String(check.reason || 'INVALID').toUpperCase()}, check.status);
        }
        const out = await selectBackend({settings: models.public(), choice: backends, user, kind});
        if (!out.ok) return send(res, {error: out.message, code: out.code, configTarget: out.configTarget || ''}, out.status);
        const consumed = await taskManager.consumeFallback(user.id, {taskId, kind});
        if (!consumed.ok) return send(res, {error: '这条回退建议已经用过了', code: 'FALLBACK_CONSUMED'}, 409);
        return send(res, {
          ok: true, current: out.current, choices: out.choices, nextTurn: true,
          fallback: {kind, label: consumed.task.fallback.label || '', depth: Number(consumed.task.fallback.depth) || 0}
        });
      }
      if (url.pathname === '/api/model/save') {
        if (body.mode === 'codex' && user.name !== 'owner') throw Error('共同测试请配置自己的 API 或本地模型');
        return send(res, await models.save(body));
      }
      if (url.pathname === '/api/model/test') {
        const c = validateModelSettings(body);
        if (c.mode === 'codex' && user.name !== 'owner') throw Error('共同测试请配置自己的 API 或本地模型');
        if (c.mode === 'codex') return send(res, {ok: true, message: 'Codex 使用本机登录；真实对话会检查其连通性。'});
        const apiKey = body.apiKey || models.snapshot().apiKey;
        return send(res, await probeApi({...c, apiKey}));
      }
      if (url.pathname === '/api/model/diag' || url.pathname === '/api/diag') {
        const c = body.settings ? validateModelSettings(body.settings) : models.snapshot();
        const apiKey = body.settings?.apiKey || models.snapshot().apiKey || '';
        const report = await runDiagnostics({...c, apiKey});
        return send(res, report);
      }
      if (url.pathname.startsWith('/api/platform/')) {
        const action = url.pathname.split('/').pop();
        if (action === 'status') return send(res, {platforms: await platforms.statuses()});
        if (action === 'open') return send(res, await platforms.open(body.platform));
        if (action === 'close') return send(res, await platforms.close(body.platform));
        if (action === 'ocr') return send(res, await platforms.ocr(body.platform));
        if (action === 'probe') return send(res, await platforms.probe());
        if (action === 'open-result') return send(res, await platformReadForTask(platforms, 'open-result', body));
        if (action === 'external') return send(res, await platforms.openExternal(body.platform));
        if (action === 'resume' || action === 'skip') {
          await load(dir, body.id);
          const pending = loginWaiters.get(body.id);
          if (!pending) return send(res, {error: '当前没有等待登录的任务'}, 409);
          pending(action);
          return send(res, {ok: true});
        }
        if (body.taskId) await load(dir, body.taskId);
        if (action === 'read' || action === 'search') return send(res, await platformReadForTask(platforms, action, body));
        return send(res, {error: '未知平台操作'}, 400);
      }
      if (url.pathname === '/api/new') {
        const s = {id: randomUUID(), title: '新的求职对话', memory: '', messages: [], artifacts: [], updatedAt: new Date().toISOString()};
        await save(dir, s);
        return send(res, s);
      }
      if (url.pathname === '/api/stop') { await load(dir, body.id); running.get(body.id)?.abort(); return send(res, {ok: true}); }
      if (url.pathname === '/api/session/rename') {
        const s = await load(dir, String(body.id || ''));
        const title = String(body.title || '').trim().slice(0, 80);
        if (!title) return send(res, {error: '标题不能为空'}, 400);
        s.title = title;
        s.updatedAt = new Date().toISOString();
        await save(dir, s);
        return send(res, {ok: true, session: {id: s.id, title: s.title, updatedAt: s.updatedAt}});
      }
      if (url.pathname === '/api/session/delete') {
        const id = String(body.id || '');
        await load(dir, id);
        if (running.has(id)) return send(res, {error: '当前对话正在执行任务，先停止再删除'}, 409);
        await unlink(file(dir, id));
        return send(res, {ok: true});
      }
      if (url.pathname === '/api/tasks/stop') {
        const out = await taskManager.stop(user.id, String(body.taskId || ''));
        if (!out.ok) return send(res, {error: out.reason === 'finished' ? '任务已结束' : '没有这个任务'}, out.reason === 'finished' ? 409 : 404);
        return send(res, {ok: true, task: out.task});
      }
      if (url.pathname === '/api/tasks/draft') {
        const out = await taskManager.setDraft(user.id, {taskId: body.taskId, draftId: body.draftId, action: body.action});
        if (!out.ok) return send(res, {error: out.reason === 'invalid-action' ? '未知的草稿动作' : '没有这个草稿'}, out.reason === 'invalid-action' ? 400 : 404);
        return send(res, {ok: true, task: out.task});
      }
      if (url.pathname === '/api/chat') {
        const s = await load(dir, body.id);
        if (running.has(s.id)) return send(res, {error: '当前对话正在执行任务'}, 409);
        const text = String(body.message || '').trim();
        if (text.length > 8000) return send(res, {error: '问题过长，请拆分到8000字以内'}, 400);
        const requestedBackend = String(body.backend || '').trim();
        if (requestedBackend && !BACKEND_CHOICES.includes(requestedBackend)) return send(res, {error: '未知的后端'}, 400);
        // 附件：文本沿用旧形状；图片统一成 {type:'image', mime, dataUrl, bytes}，只在本轮内存里用，不写进会话。
        const attachments = [];
        for (const item of (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)) {
          if (!item || typeof item.name !== 'string') continue;
          if (isImageAttachment(item)) {
            const image = normalizeImageAttachment(item);
            if (!image) return send(res, {error: '图片无法读取或单张超过 8MB'}, 413);
            attachments.push(image);
          } else if (typeof item.text === 'string' && item.text.length <= 40000) {
            attachments.push({name: item.name, text: item.text});
          }
        }
        const images = attachments.filter(item => item.type === 'image');
        const totalImageBytes = images.reduce((sum, item) => sum + item.bytes, 0);
        if (totalImageBytes > MAX_IMAGE_BYTES) return send(res, {error: '图片总量超过 8MB，请压缩或减少图片后重试'}, 413);
        if (!text && !attachments.length) return send(res, {error: '请输入问题或上传资料'}, 400);
        const lock = body.lock === true;
        // fallbackDepth 由客户端在「换 X 重试」后递增；服务端用它和连续失败计数一起封顶 3 次建议。
        const fallbackDepth = Math.max(0, Math.min(9, Math.trunc(Number(body.fallbackDepth) || 0)));
        const isFallbackTurn = fallbackDepth > 0;
        // 能力解析：当前后端不满足本轮能力就停下来给候选卡，不静默降级。
        const turn = resolveTurn({settings: models.public(), choice: backends, user, requested: requestedBackend, attachments});
        if (!turn.ok) {
          res.writeHead(200, {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
          const guide = turn.candidates.some(card => card.configured) ? '' : '还没有可用的候选后端，请先到「模型与接口设置」完成配置。';
          const emitBlocked = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
          emitBlocked({type: 'status', text: '正在检查本轮所需的后端能力'});
          emitBlocked({type: 'candidate_required', code: 'CANDIDATE_REQUIRED', capabilities: turn.capabilities, current: turn.current, candidates: turn.candidates, message: turn.message, guide});
          emitBlocked({type: 'error', code: 'CANDIDATE_REQUIRED', text: turn.message + (guide ? ' ' + guide : ''), candidates: turn.candidates});
          res.end();
          return;
        }
        // 会话历史只存图片的元数据，不存 dataUrl。
        const historyAttachments = attachments.map(item => item.type === 'image'
          ? {name: item.name, type: 'image', mime: item.mime, bytes: item.bytes}
          : {name: item.name, text: item.text});
        const controller = new AbortController();
        running.set(s.id, controller);
        owners.set(s.id, user);
        const taskBridgeToken = randomBytes(32).toString('hex');
        bridgeTokens.set(taskBridgeToken, s.id);
        s.lastTask = {status: 'running', phase: '正在制定计划', startedAt: new Date().toISOString(), plan: null};
        await save(dir, s);
        res.writeHead(200, {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
        const emit = e => {
          if (e.type === 'status') s.lastTask.phase = e.text;
          if (e.type === 'plan') s.lastTask.plan = e.plan;
          if (!res.destroyed) res.write(JSON.stringify(e) + '\n');
        };
        taskEvents.set(s.id, emit);
        emit({type: 'status', text: '正在理解你的需求'});
        const tick = setInterval(() => emit({type: 'heartbeat'}), 15000);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const modelConfig = models.snapshot();
          // 换后端只由一次点击发生：settings.fallback 里的旧备用接口保持惰性，不在这里静默切换。
          const backend = turn.backend;
          // 任务生命周期（排队/运行/终态、15 分钟上限、证据与草稿）交给 TaskManager；执行体仍是原来的 runAgent。
          const outcome = await taskManager.run({
            userId: user.id,
            sessionId: s.id,
            title: s.title === '新的求职对话' ? (text || attachments[0]?.name || '求职对话') : s.title,
            sourceName: attachments[0]?.name || '对话',
            signal: controller.signal,
            emit,
            describeError: e => decorateChatError(e.message, !!modelConfig.apiKey),
            // 失败后最多给一条建议：锁定、本轮已有工具成功、建议满 3 次、连续失败超过 3 次都不给。
            onFailure: async ({error}) => {
              if (['QUEUE_TIMEOUT', 'TASK_TIMEOUT', 'CANCELLED'].includes(error?.code)) return null;
              const streak = (failureStreaks.get(s.id) || 0) + 1;
              failureStreaks.set(s.id, streak);
              const out = suggestFallback({
                settings: models.public(),
                user,
                capabilities: turn.capabilities,
                currentKind: backend.kind,
                depth: fallbackDepth,
                streak,
                locked: lock,
                hadToolSuccess: error?.hadToolSuccess === true
              });
              if (!out.ok) return null;
              return {...out.suggestion, message: text.slice(0, 8000)};
            },
            execute: async ({task, signal, emit: runEmit, addDraft}) => {
              if (backend.kind === 'codex' && user.name !== 'owner') throw Error('请先在模型与接口设置中配置自己的 API 或本地模型');
              const profile = (await loadProfile(dir)).facts;
              const skill = await selectSkill(root, text).catch(() => null);
              const result = await runAgent({
                root,
                modelCall: options => backend.kind === 'codex'
                  ? runModel({...options, taskBridgeToken})
                  : runApiModel({...options, config: {...modelConfig, bridgeToken: taskBridgeToken, recruitDir: dir, dataDir: dir, userId: user.id, taskId: task.id, actorRef: backend.label}}),
                backend,
                images,
                session: s,
                message: text || '请阅读附件并询问我希望完成什么任务。',
                attachments: historyAttachments,
                profile,
                skill,
                onEvent: runEmit,
                signal,
                fallback: isFallbackTurn
              });
              if (result.artifact.content.trim()) addDraft({title: result.artifact.title || '求职文稿', content: result.artifact.content});
              return result;
            }
          });
          if (outcome.error) {
            // 回退建议已由 TaskManager 的 onFailure 算好并写进任务记录，fallback_suggested 先于 error 发出。
            // 排队超时/执行失败/取消：TaskManager 已经写过 error 事件，这里只收尾会话与任务记录。
            s.lastTask = {...s.lastTask, status: outcome.task.state === 'cancelled' ? 'stopped' : 'failed', error: outcome.task.error?.message || outcome.error.message, taskId: outcome.task.id, fallback: outcome.task.fallback || null};
            await save(dir, s);
            await recordTask(dir, {sessionId: s.id, title: s.title, status: 'failed', error: s.lastTask.error}).catch(() => {});
          } else {
            failureStreaks.delete(s.id);
            const result = outcome.result;
            s.messages.push({role: 'user', content: text, attachments: historyAttachments}, {role: 'assistant', backend: backend.label, backendKind: backend.kind, locked: lock, fallback: isFallbackTurn, calls: result.calls, content: result.reply, skill: result.skill?.id || '', sources: result.sources, trace: result.trace, visualization: result.visualization, plan: result.plan, quality: result.quality, durationMs: result.durationMs});
            s.memory = result.memory.slice(0, 5000);
            s.lastTask = {...s.lastTask, status: 'complete', taskId: outcome.task.id, quality: result.quality, durationMs: result.durationMs, finishedAt: new Date().toISOString()};
            if (result.artifact.content.trim()) s.artifacts.push({id: randomUUID(), title: result.artifact.title || '求职文稿', content: result.artifact.content, createdAt: new Date().toISOString()});
            if (s.title === '新的求职对话') s.title = (text || attachments[0]?.name || '求职对话').slice(0, 25);
            s.updatedAt = new Date().toISOString();
            await save(dir, s);
            await recordTask(dir, {
              sessionId: s.id, title: s.title, status: 'complete',
              steps: result.plan?.steps || [],
              tools: (result.trace || []).map(t => t.label || t.type).filter(Boolean),
              artifact: result.artifact?.title || '',
              skill: result.skill?.name || '',
              durationMs: result.durationMs
            }).catch(() => {});
            emit({type: 'done', session: s});
          }
        } catch (e) {
          const friendly = decorateChatError(e.message, !!models.snapshot().apiKey);
          s.lastTask = {...s.lastTask, status: controller.signal.aborted ? 'stopped' : 'failed', error: friendly};
          await save(dir, s);
          await recordTask(dir, {sessionId: s.id, title: s.title, status: 'failed', error: friendly}).catch(() => {});
          emit({type: 'error', text: friendly});
        } finally {
          clearInterval(tick);
          running.delete(s.id);
          owners.delete(s.id);
          bridgeTokens.delete(taskBridgeToken);
          taskEvents.delete(s.id);
          for (const key of loginPrompted) if (key.startsWith(s.id + ':')) loginPrompted.delete(key);
          res.end();
        }
        return;
      }
    }

    send(res, {error: 'Not found'}, 404);
  } catch (e) {
    if (!res.headersSent) send(res, {error: e.message || '请求失败'}, 400); else res.end();
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(actualPort, host, resolve); });
actualPort = server.address().port;
localOrigin = 'http://127.0.0.1:' + actualPort;
allowedHosts = buildAllowedHosts(actualPort);
let closing = null;
const close = () => closing || (closing = (async () => {
  for (const controller of running.values()) controller.abort();
  // 外部 Agent 的常驻连接与子进程走同一回收路径；租户还没建起来时跳过。
  await Promise.allSettled([...tenants.values()].map(promise => promise.then(t => t.connections.closeAll()).catch(() => {})));
  inboundMcp.close().catch(() => {});
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve()));
})());
return {server, token, dataDir, root, host, port: actualPort, origin: localOrigin, close, tasks: taskManager};
}