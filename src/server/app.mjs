import {Accounts} from './accounts.mjs';
import {ModelSettings, validateModelSettings, backendLabel} from '../model/model-settings.mjs';
import {presetOptions, decorateChatError} from '../model/providers.mjs';
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
import {TaskQueue} from './task-queue.mjs';
import {TaskStore, publicTask} from './task-store.mjs';
import {listTools} from '../tools/registry.mjs';
import {createToolExecutor} from '../tools/execute.mjs';
import {InboundMcp, requestFromNode, writeNodeResponse} from '../mcp/inbound.mjs';
import {listSkills, selectSkill} from '../skills/index.mjs';
import {memorySummary, buildMemoryPayload, addFact, deleteFact, clearProfile, importSessionMemory, loadProfile, recordTask, clearTasks} from '../agent/memory.mjs';

// 应用工厂：装配一个可启动的实例，不做进程级的事（环境变量、日志格式归 index.mjs）。
// 返回 {server, token, dataDir, host, port, origin, close}；port 传 0 时由系统分配，close 幂等。
export async function createApp({
  dataDir,
  root = fileURLToPath(new URL('../..', import.meta.url)),
  host = '127.0.0.1',
  port = 0,
  limits = {}
} = {}) {
if (!dataDir) throw new Error('createApp 需要 dataDir：准备数据目录是进程级入口（index.mjs）的职责');
await mkdir(dataDir, {recursive: true});
const tokenFile = join(dataDir, 'local-session-token');
let token = await readFile(tokenFile, 'utf8').catch(() => '');
if (!/^[a-f0-9]{48}$/.test(token)) { token = randomBytes(24).toString('hex'); await writeFile(tokenFile, token, 'utf8'); }
// 任务闸与任务记录的默认值；测试用 limits 调小，正式运行保持规格里的数字。
const lim = {userTaskLimit: 2, globalTaskLimit: 8, queueTimeoutMs: 120000, taskTimeLimitMs: 15 * 60 * 1000, heartbeatMs: 15000, ...limits};
const queue = new TaskQueue({userLimit: lim.userTaskLimit, globalLimit: lim.globalTaskLimit, waitLimitMs: lim.queueTimeoutMs});
const runs = new Map(), taskControls = new Map(), taskEvents = new Map(), loginWaiters = new Map(), loginPrompted = new Set();
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
    return {dir: tenantData, models: model, platforms: new PlatformBrowser(home), vault, tasks: await new TaskStore(tenantData).load()};
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
    return createToolExecutor()(name, args, {taskId: '', config: {searchUrl: model.searchUrl, recruitDir: t.dir, dataDir: t.dir}, signal: AbortSignal.timeout(180000)});
  }
}).init();
const send = (res, obj, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); };
const sendFile = (res, body, type, name) => { res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', ...(name ? {'Content-Disposition': 'attachment; filename="' + name + '"'} : {})}); res.end(body); };
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const file = (dir, id) => join(dir, id + '.json');
async function load(dir, id) { if (!validId(id)) throw new Error('无效会话'); return JSON.parse(await readFile(file(dir, id), 'utf8')); }
async function save(dir, s) { await writeFile(file(dir, s.id), JSON.stringify(s, null, 2), 'utf8'); }

async function platformReadForTask(platforms, action, body) {
  const execute = () => action === 'search' ? platforms.search(body.platform, body.query) : action === 'open-result' ? platforms.openResult(body.platform) : platforms.read(body.platform);
  const result = await execute();
  const emit = taskEvents.get(body.taskId), run = runs.get(body.taskId), key = body.taskId + ':' + body.platform;
  if (!emit || !run || !['needs_connection', 'needs_login', 'needs_user', 'needs_verification', 'unconfirmed', 'load_failed'].includes(result.status) || loginPrompted.has(key)) return result;
  loginPrompted.add(key);
  // 等本人登录也是「等你操作」：任务卡进待确认，顶栏徽标会计数；继续或跳过后回到运行中。
  const control = taskControls.get(body.taskId);
  const move = state => {
    if (!control) return;
    try { control.setState(state); control.progress(state === 'waiting_confirmation' ? '等待你在页面上确认平台登录' : '已继续执行'); } catch { /* 任务已结束时忽略 */ }
  };
  emit({type: 'platform_required', platform: body.platform, platformName: PLATFORM_SITES[body.platform]?.name || body.platform, reason: result.message, taskId: body.taskId});
  move('waiting_confirmation');
  const choice = await new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); run.controller.signal.removeEventListener('abort', abort); loginWaiters.delete(body.taskId); resolve(value); };
    const abort = () => finish('cancel');
    const timer = setTimeout(() => finish('timeout'), 300000);
    loginWaiters.set(body.taskId, finish); run.controller.signal.addEventListener('abort', abort, {once: true}); if (run.controller.signal.aborted) abort();
  });
  emit({type: 'platform_resolved', platform: body.platform});
  move('running');
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

    if (req.method === 'GET' && ['/ui-model.js', '/capabilities.js', '/memory.js', '/artifact.js', '/workflow.js', '/vendor/mammoth.js', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs'].includes(url.pathname)) {
      const assets = {'/ui-model.js': 'src/web/ui-model.js', '/capabilities.js': 'src/web/capabilities.js', '/memory.js': 'src/web/memory.js', '/artifact.js': 'src/web/artifact.js', '/workflow.js': 'src/web/workflow.js', '/vendor/mammoth.js': 'node_modules/mammoth/mammoth.browser.min.js', '/vendor/pdf.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', '/vendor/pdf.worker.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'};
      const content = await readFile(join(root, assets[url.pathname]));
      res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
      return res.end(content);
    }

    // 跨站请求防护：Origin 必须与当前访问地址一致
    if (req.headers.origin && req.headers.origin !== requestOrigin && req.headers.origin !== localOrigin) return send(res, {error: 'Origin rejected'}, 403);

    // 对外 MCP 入站：现有端口上的 /mcp，自带 bearer 鉴权，不走网页会话口令。
    if (url.pathname === '/mcp') {
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) return send(res, {error: 'Method not allowed'}, 405);
      // 实例开关关闭时端点不存在：即使带着有效凭据也回 404。
      if (!inboundMcp.enabled) return send(res, {error: 'Not found'}, 404);
      let webRequest;
      try { webRequest = await requestFromNode(req, localOrigin); }
      catch (error) { if (error.status === 413) return send(res, {error: error.message}, 413); throw error; }
      const response = await inboundMcp.handle(webRequest);
      if (!response) return send(res, {error: 'Not found'}, 404);
      return writeNodeResponse(res, response);
    }

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
      if (bridgeTokens.get(req.headers['x-career-token']) !== b.taskId || !user || !runs.has(b.taskId)) return send(res, {error: '任务无权访问'}, 403);
      const t = await tenant(user);
      return send(res, url.pathname.endsWith('/status') ? {platforms: await t.platforms.statuses()} : await platformReadForTask(t.platforms, url.pathname.split('/').pop(), b));
    }
    if (!user) return send(res, {error: '请先登录自己的测试账号'}, 401);

    const {dir, models, platforms} = await tenant(user);

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
    if (req.method === 'GET' && url.pathname === '/api/model/presets') return send(res, {presets: presetOptions()});
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const sessionId = url.searchParams.get('session') || '';
      let session = null;
      if (sessionId) { try { session = await load(dir, sessionId); } catch { session = null; } }
      return send(res, await buildMemoryPayload(dir, session));
    }
    if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(res, {tools: listTools(), skills: await listSkills(root), memory: await memorySummary(dir)});
    if (req.method === 'GET' && url.pathname === '/api/mcp') return send(res, (await inboundMcp.status(user.id)).json);

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
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const store = (await tenant(user)).tasks;
      return send(res, {tasks: store.list({sessionId: url.searchParams.get('session') || ''}), queue: queue.stats()});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const store = (await tenant(user)).tasks;
      const task = store.find(decodeURIComponent(url.pathname.slice('/api/tasks/'.length)));
      if (!task) return send(res, {error: '任务不存在'}, 404);
      return send(res, {task: {...publicTask(task), events: task.events}});
    }

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

    if (req.method === 'POST') {
      let raw = '';
      for await (const b of req) { raw += b.toString(); if (raw.length > 400000) return send(res, {error: '本次资料过多，请分批发送'}, 413); }
      const body = JSON.parse(raw || '{}');

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
      if (url.pathname === '/api/stop') {
        await load(dir, body.id);
        const run = runs.get(body.id);
        if (run) { run.stopReason = 'user'; run.controller.abort(); }
        return send(res, {ok: true});
      }
      if (url.pathname === '/api/tasks/cancel') {
        const store = (await tenant(user)).tasks, task = store.find(String(body.id || ''));
        if (!task) return send(res, {error: '任务不存在'}, 404);
        const run = runs.get(task.sessionId);
        if (!run || run.taskId !== task.id) return send(res, {error: '任务已经结束，不需要停止'}, 409);
        run.stopReason = 'user';
        run.controller.abort();
        return send(res, {ok: true});
      }
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
        if (runs.has(id)) return send(res, {error: '当前对话正在执行任务，先停止再删除'}, 409);
        await unlink(file(dir, id));
        return send(res, {ok: true});
      }
      if (url.pathname === '/api/chat') {
        const s = await load(dir, body.id);
        if (runs.has(s.id)) return send(res, {error: '当前对话正在执行任务'}, 409);
        const text = String(body.message || '').trim();
        if (text.length > 8000) return send(res, {error: '问题过长，请拆分到8000字以内'}, 400);
        const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5).filter(a => typeof a.name === 'string' && typeof a.text === 'string' && a.text.length <= 40000);
        if (!text && !attachments.length) return send(res, {error: '请输入问题或上传资料'}, 400);
        const modelConfig = models.snapshot();
        if (modelConfig.mode === 'codex' && user.name !== 'owner') return send(res, {error: '请先在模型与接口设置中配置自己的 API 或本地模型'}, 400);

        // 一个聊天请求 = 一个任务：先落成 queued，拿到任务闸名额后才 running。
        const store = (await tenant(user)).tasks;
        const sourceName = typeof body.sourceName === 'string' ? body.sourceName.trim().slice(0, 40) : '';
        const title = (sourceName ? '来源校对 · ' + sourceName : text || attachments[0]?.name || '求职对话').slice(0, 25);
        const task = store.create({sessionId: s.id, title, backend: backendLabel(modelConfig), sourceName});
        const controller = new AbortController();
        const run = {controller, taskId: task.id, stopReason: ''};
        runs.set(s.id, run);
        owners.set(s.id, user);
        const taskBridgeToken = randomBytes(32).toString('hex');
        bridgeTokens.set(taskBridgeToken, s.id);
        s.lastTask = {status: 'queued', phase: '排队中', startedAt: '', taskId: task.id, plan: null};
        await save(dir, s);

        res.writeHead(200, {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
        const write = payload => { if (!res.destroyed) res.write(JSON.stringify(payload) + '\n'); };
        const snapshot = () => publicTask(task);
        const initialEvent = task.events[task.events.length - 1];
        write({...initialEvent, taskId: task.id, task: snapshot()});
        const push = event => {
          const stored = store.record(task, event);
          if (event.type === 'status') s.lastTask.phase = event.text;
          if (event.type === 'plan') s.lastTask.plan = event.plan;
          write({...stored, taskId: task.id, task: snapshot()});
          return stored;
        };
        const setState = (state, info = {}) => {
          const stored = store.transition(task, state, info);
          write({...stored, taskId: task.id, task: snapshot()});
          return stored;
        };
        let percent = 0;
        const progress = (label, next) => {
          percent = typeof next === 'number' ? Math.max(percent, Math.min(100, next)) : Math.min(92, percent + 8);
          push({type: 'progress', percent, text: label || ''});
        };
        // 三种结束方式共用一条收尾：写错误事件、推进状态、同步 lastTask。
        const finishWithFailure = ({state, code, text: message, recovery, reason = ''}) => {
          push({type: 'error', text: message, code, recovery});
          setState(state, {reason});
          s.lastTask = {...s.lastTask, status: state === 'cancelled' ? 'stopped' : 'failed', error: message};
        };
        taskControls.set(s.id, {taskId: task.id, setState, progress});
        taskEvents.set(s.id, push);
        let release = null, tick = null;
        const finish = async () => {
          if (tick) { clearInterval(tick); tick = null; }
          if (release) { release(); release = null; }
          if (runs.get(s.id) === run) runs.delete(s.id);
          if (taskControls.get(s.id)?.taskId === task.id) taskControls.delete(s.id);
          owners.delete(s.id);
          bridgeTokens.delete(taskBridgeToken);
          taskEvents.delete(s.id);
          for (const key of loginPrompted) if (key.startsWith(s.id + ':')) loginPrompted.delete(key);
          await store.flush();
          if (!res.writableEnded) res.end();
        };
        res.on('close', () => {
          if (res.writableEnded) return;
          if (!run.stopReason) run.stopReason = 'client_closed';
          controller.abort();
        });

        // 排队期间也要发心跳，避免 120 秒的等待被当成失联。
        tick = setInterval(() => write({type: 'heartbeat', taskId: task.id}), lim.heartbeatMs);
        try {
          release = await queue.acquire(user.id, {signal: controller.signal});
        } catch (e) {
          if (e.code === 'QUEUE_TIMEOUT') {
            push({type: 'error', text: e.message, code: 'QUEUE_TIMEOUT', recovery: '先停止不需要的任务，或稍后重试。'});
            setState('failed');
            s.lastTask = {...s.lastTask, status: 'failed', error: e.message};
          } else {
            setState('cancelled', {reason: run.stopReason || 'client_closed'});
            s.lastTask = {...s.lastTask, status: 'stopped'};
          }
          await save(dir, s);
          await finish();
          return;
        }

        try {
          s.lastTask = {...s.lastTask, status: 'running', phase: '正在制定计划', startedAt: new Date().toISOString()};
          await save(dir, s);
          setState('running');
          progress('开始执行', 5);
          const profile = (await loadProfile(dir)).facts;
          const skill = await selectSkill(root, text).catch(() => null);
          const result = await runAgent({
            root,
            modelCall: options => modelConfig.mode === 'codex'
              ? runModel({...options, taskBridgeToken})
              : runApiModel({...options, config: {...modelConfig, bridgeToken: taskBridgeToken, recruitDir: dir, dataDir: dir}}),
            session: s,
            message: text || '请阅读附件并询问我希望完成什么任务。',
            attachments,
            profile,
            skill,
            // 15 分钟是整任务的墙钟上限：排队花掉的时间也从这里扣。
            timeLimitMs: Math.max(1, lim.taskTimeLimitMs - Math.max(0, Date.now() - (Date.parse(task.createdAt) || Date.now()))),
            onEvent: event => {
              push(event);
              if (event.type === 'status' || event.type === 'tool') progress(event.text);
              else if (event.type === 'evidence') progress('已取得证据');
            },
            signal: controller.signal
          });
          s.messages.push({role: 'user', content: text, attachments}, {role: 'assistant', backend: backendLabel(modelConfig), content: result.reply, skill: result.skill?.id || '', sources: result.sources, trace: result.trace, visualization: result.visualization, plan: result.plan, quality: result.quality, durationMs: result.durationMs});
          s.memory = result.memory.slice(0, 5000);
          s.lastTask = {...s.lastTask, status: 'complete', quality: result.quality, durationMs: result.durationMs, finishedAt: new Date().toISOString()};
          if (result.artifact.content.trim()) {
            const artifact = {id: randomUUID(), title: result.artifact.title || '求职文稿', content: result.artifact.content, createdAt: new Date().toISOString()};
            s.artifacts.push(artifact);
            push({type: 'draft', draft: {artifactId: artifact.id, title: artifact.title, chars: artifact.content.length}});
          }
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
          progress('已完成', 100);
          setState('succeeded');
          write({type: 'done', session: s, taskId: task.id, task: snapshot()});
        } catch (e) {
          const timedOut = e.code === 'TASK_TIMEOUT';
          if (timedOut) {
            run.stopReason = 'time_limit';
            finishWithFailure({state: 'failed', code: 'TASK_TIMEOUT', text: e.message, reason: 'time_limit', recovery: '把任务拆小再试，或在设置里换更快的接口。'});
          } else if (run.stopReason || controller.signal.aborted) {
            const reason = run.stopReason || 'user';
            finishWithFailure({
              state: 'cancelled', code: 'CANCELLED', reason,
              text: reason === 'client_closed' ? '连接已断开，任务停止。' : '已停止本次任务。',
              recovery: '重新发送即可重试。'
            });
          } else {
            finishWithFailure({state: 'failed', code: 'TASK_FAILED', text: decorateChatError(e.message, !!models.snapshot().apiKey), recovery: '检查错误后重试，或换一个可用的执行后端。'});
          }
          await save(dir, s);
          await recordTask(dir, {sessionId: s.id, title: s.title, status: s.lastTask.status === 'stopped' ? 'stopped' : 'failed', error: s.lastTask.error}).catch(() => {});
        } finally {
          await finish();
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
const close = () => closing || (closing = new Promise(resolve => {
  for (const run of runs.values()) run.controller.abort();
  inboundMcp.close().catch(() => {});
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => resolve());
}));
return {server, token, dataDir, root, host, port: actualPort, origin: localOrigin, close};
}
