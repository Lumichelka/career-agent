import {Accounts} from './accounts.mjs';
import {ModelSettings, validateModelSettings, backendLabel} from '../model/model-settings.mjs';
import {presetOptions, decorateChatError} from '../model/providers.mjs';
import {runApiModel, probeApi} from '../model/api-model.mjs';
import {runDiagnostics} from '../model/diag.mjs';
import {KeyVault} from '../model/keyvault.mjs';
import {PlatformBrowser} from '../platform/platforms.mjs';
import {handleRecruit} from '../recruit/api.mjs';
import http from 'node:http';
import os from 'node:os';
import {readFile, mkdir, writeFile, readdir, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {runAgent, runModel} from '../agent/agent.mjs';
import {prepareDataDir} from '../config/paths.mjs';
import {listTools} from '../tools/registry.mjs';
import {listSkills, selectSkill} from '../skills/index.mjs';
import {memorySummary, buildMemoryPayload, addFact, deleteFact, clearProfile, importSessionMemory, loadProfile, recordTask, clearTasks} from '../agent/memory.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = await prepareDataDir({root, log: message => console.log(message)});
const tokenFile = join(dataDir, 'local-session-token');
let token = await readFile(tokenFile, 'utf8').catch(() => '');
if (!/^[a-f0-9]{48}$/.test(token)) { token = randomBytes(24).toString('hex'); await writeFile(tokenFile, token, 'utf8'); }
const running = new Map(), taskEvents = new Map(), loginWaiters = new Map(), loginPrompted = new Set();
const port = Number(process.env.PORT || 4189);
const host = process.env.CAREER_HOST || '127.0.0.1';
const localOrigin = 'http://127.0.0.1:' + port;

// 多设备访问：默认只监听本机；CAREER_HOST=0.0.0.0 时开放局域网，但保留口令与账号两道门槛。
const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port, '127.0.0.1', 'localhost']);
if (host !== '127.0.0.1') {
  for (const list of Object.values(os.networkInterfaces())) for (const net of list || []) if (net.family === 'IPv4' && !net.internal) { allowedHosts.add(net.address + ':' + port); allowedHosts.add(net.address); }
}
for (const extra of String(process.env.CAREER_ALLOWED_HOSTS || '').split(',')) { const h = extra.trim(); if (h) { allowedHosts.add(h); allowedHosts.add(h + ':' + port); } }
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
    return {dir: tenantData, models: model, platforms: new PlatformBrowser(home), vault};
  })());
  return tenants.get(user.id);
}
process.env.CAREER_BRIDGE_URL = localOrigin; process.env.CAREER_BRIDGE_TOKEN = token;
const send = (res, obj, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); };
const sendFile = (res, body, type, name) => { res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', ...(name ? {'Content-Disposition': 'attachment; filename="' + name + '"'} : {})}); res.end(body); };
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const file = (dir, id) => join(dir, id + '.json');
async function load(dir, id) { if (!validId(id)) throw new Error('无效会话'); return JSON.parse(await readFile(file(dir, id), 'utf8')); }
async function save(dir, s) { await writeFile(file(dir, s.id), JSON.stringify(s, null, 2), 'utf8'); }

async function platformReadForTask(platforms, action, body) {
  const execute = () => action === 'search' ? platforms.search(body.platform, body.query) : platforms.read(body.platform);
  const result = await execute();
  const emit = taskEvents.get(body.taskId), controller = running.get(body.taskId), key = body.taskId + ':' + body.platform;
  if (!emit || !controller || !['needs_connection', 'needs_login', 'needs_user', 'needs_verification', 'unconfirmed', 'load_failed'].includes(result.status) || loginPrompted.has(key)) return result;
  loginPrompted.add(key);
  emit({type: 'platform_required', platform: body.platform, reason: result.message, taskId: body.taskId});
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

http.createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host || '';
    if (!hostAllowed(hostHeader)) return send(res, {error: 'Host rejected'}, 403);
    const requestOrigin = 'http://' + hostHeader;
    const url = new URL(req.url, requestOrigin);

    if (req.method === 'GET' && url.pathname === '/health') return send(res, {app: 'career-agent', status: 'ready', host, port});

    if (req.method === 'GET' && ['/', '/today', '/index.html'].includes(url.pathname)) {
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

    if (req.method === 'GET' && ['/ui-model.js', '/capabilities.js', '/memory.js', '/vendor/mammoth.js', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs'].includes(url.pathname)) {
      const assets = {'/ui-model.js': 'src/web/ui-model.js', '/capabilities.js': 'src/web/capabilities.js', '/memory.js': 'src/web/memory.js', '/vendor/mammoth.js': 'node_modules/mammoth/mammoth.browser.min.js', '/vendor/pdf.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', '/vendor/pdf.worker.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'};
      const content = await readFile(join(root, assets[url.pathname]));
      res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
      return res.end(content);
    }

    // 跨站请求防护：Origin 必须与当前访问地址一致
    if (req.headers.origin && req.headers.origin !== requestOrigin && req.headers.origin !== localOrigin) return send(res, {error: 'Origin rejected'}, 403);
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

    const {dir, models, platforms} = await tenant(user);

    if (url.pathname === '/api/auth/me') return send(res, {user: {name: user.name, id: user.id}});
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
      if (url.pathname === '/api/chat') {
        const s = await load(dir, body.id);
        if (running.has(s.id)) return send(res, {error: '当前对话正在执行任务'}, 409);
        const text = String(body.message || '').trim();
        if (text.length > 8000) return send(res, {error: '问题过长，请拆分到8000字以内'}, 400);
        const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5).filter(a => typeof a.name === 'string' && typeof a.text === 'string' && a.text.length <= 40000);
        if (!text && !attachments.length) return send(res, {error: '请输入问题或上传资料'}, 400);
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
          if (modelConfig.mode === 'codex' && user.name !== 'owner') throw Error('请先在模型与接口设置中配置自己的 API 或本地模型');
          const profile = (await loadProfile(dir)).facts;
          const skill = await selectSkill(root, text).catch(() => null);
          const result = await runAgent({
            root,
            modelCall: options => modelConfig.mode === 'codex'
              ? runModel({...options, taskBridgeToken})
              : runApiModel({...options, config: {...modelConfig, bridgeToken: taskBridgeToken, recruitDir: dir}}),
            session: s,
            message: text || '请阅读附件并询问我希望完成什么任务。',
            attachments,
            profile,
            skill,
            onEvent: emit,
            signal: controller.signal
          });
          s.messages.push({role: 'user', content: text, attachments}, {role: 'assistant', backend: backendLabel(modelConfig), content: result.reply, skill: result.skill?.id || '', sources: result.sources, trace: result.trace, visualization: result.visualization, plan: result.plan, quality: result.quality, durationMs: result.durationMs});
          s.memory = result.memory.slice(0, 5000);
          s.lastTask = {...s.lastTask, status: 'complete', quality: result.quality, durationMs: result.durationMs, finishedAt: new Date().toISOString()};
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
}).listen(port, host, () => {
  const lan = host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => 'http://' + n.address + ':' + port) : [];
  console.log('职向智能体：http://127.0.0.1:' + port);
  if (lan.length) console.log('局域网访问（同一 Wi-Fi 的其它设备）：' + lan.join(' '));
  console.log('只保存本机数据；不会收集招聘平台密码。首次进入请用 ' + join(dataDir, '首次登录.txt') + ' 里的账号登录。');
});
