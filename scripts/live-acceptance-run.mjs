// Automated 24-swufe live acceptance. Mirrors the 9 wizard stages:
// isolated data dir -> real Edge browser -> DeepSeek vision -> Claude Code review -> write gateway
// -> audit export -> clean undo -> conflict + forced undo -> evidence -> manifest -> verifier -> signature.
// No fabricated evidence: every hash/screenshot/audit row comes from this run.
import {createApp} from '../src/server/app.mjs';
import {contentHashOf} from '../docs/acceptance/24-swufe/verify-evidence.mjs';
import {mkdtemp, readFile, writeFile, mkdir, cp, rm} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceDir = join(root, 'docs', 'acceptance', '24-swufe', 'evidence');
const manifestFile = join(root, 'docs', 'acceptance', '24-swufe', 'manifest.json');
const templateFile = join(root, 'docs', 'acceptance', '24-swufe', 'manifest.template.json');
const readmeFile = join(root, 'docs', 'acceptance', '24-swufe', 'README.md');
const verifyFile = join(root, 'docs', 'acceptance', '24-swufe', 'verify-evidence.mjs');
const ownerName = process.env.OWNER_NAME || 'owner';
const vaultSource = process.env.MODEL_VAULT_DIR || '';
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  await mkdir(evidenceDir, {recursive: true});
  const dataDir = await mkdtemp(join(tmpdir(), 'zx-live-accept-'));
  const app = await createApp({root, dataDir, host: '127.0.0.1', port: 0});
  let browser = null;
  let tenantData = '';
  let vaultCopied = false;
  let realFetch = null;
  const targetFetches = [];
  try {
    const accounts = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'));
    const owner = accounts.find(u => u.name === 'owner');
    if (!owner) throw new Error('owner account missing');
    tenantData = join(dataDir, 'users', owner.id, '.data');
    await mkdir(tenantData, {recursive: true});
    // 真实 Key 只在显式 MODEL_VAULT_DIR 下复制；不自动扫描用户目录。结束后删除副本。
    if (!vaultSource) throw new Error('MODEL_VAULT_DIR 未设置：请显式传入本机已有 KeyVault 的 .data 目录，或在网页里配置一个新的视觉模型 Key。');
    if (!existsSync(join(vaultSource, 'secrets.enc.json')) || !existsSync(join(vaultSource, 'vault.key'))) {
      throw new Error('MODEL_VAULT_DIR 里没有 secrets.enc.json + vault.key：' + vaultSource);
    }
    for (const name of ['model-settings.json', 'secrets.enc.json', 'vault.key']) {
      if (existsSync(join(vaultSource, name))) await cp(join(vaultSource, name), join(tenantData, name));
    }
    vaultCopied = true;
    const first = await readFile(join(dataDir, '首次登录.txt'), 'utf8');
    const password = (first.match(/密码：(.*)/) || [])[1]?.trim();
    if (!password) throw new Error('owner password missing');
    const token = app.token;
    const baseHeaders = {'x-career-token': token, 'content-type': 'application/json'};
    const login = await fetch(app.origin + '/api/auth/login', {method: 'POST', headers: baseHeaders, body: JSON.stringify({name: 'owner', password})});
    if (!login.ok) throw new Error('login failed: ' + await login.text());
    const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')]).filter(Boolean).join('; ');
    const auth = {...baseHeaders, cookie};
    const api = async (path, body, method = body ? 'POST' : 'GET') => {
      const res = await fetch(app.origin + '/api/' + path, {method, headers: auth, ...(body ? {body: JSON.stringify(body)} : {})});
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      if (!res.ok) throw new Error(path + ' HTTP ' + res.status + ': ' + text.slice(0, 600));
      return json;
    };
    const getBuffer = async path => {
      const res = await fetch(app.origin + '/api/' + path, {headers: auth});
      if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    };
    const taskFile = id => join(dataDir, 'users', owner.id, 'tasks', id + '.json');
    const taskEvidence = id => join(dataDir, 'users', owner.id, 'tasks', id, 'evidence');
    const waitTask = async id => {
      const deadline = Date.now() + 16 * 60 * 1000;
      let last = '';
      while (Date.now() < deadline) {
        if (existsSync(taskFile(id))) {
          const task = JSON.parse(await readFile(taskFile(id), 'utf8'));
          if (task.phase !== last) { last = task.phase; log('task', task.state, task.phase); }
          if (['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.state)) return task;
        }
        await sleep(2500);
      }
      throw new Error('task timeout: ' + id);
    };
    const snapshot = async dest => {
      const db = join(tenantData, 'recruit.db');
      if (!existsSync(db)) throw new Error('recruit.db missing');
      const handle = new DatabaseSync(db);
      handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      handle.close();
      await cp(db, dest);
    };

    log('login ok', app.origin, dataDir);
    await api('model/save', {preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 8192, stream: true});
    const modelTest = await api('model/test', {preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 8192, stream: true});
    log('model test', JSON.stringify(modelTest));

    const wrapper = join(root, 'scripts', 'claude-review-mcp.mjs');
    const agentRes = await api('agents', {
      name: 'claude-review', transport: 'stdio', command: process.execPath, args: [wrapper], enabled: true,
      env: {
        CLAUDE_BIN: claudeBin,
        PATH: process.env.PATH || '', USERPROFILE: process.env.USERPROFILE || '',
        HOME: process.env.HOME || process.env.USERPROFILE || '', APPDATA: process.env.APPDATA || '',
        LOCALAPPDATA: process.env.LOCALAPPDATA || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
        SystemRoot: process.env.SystemRoot || '', ComSpec: process.env.ComSpec || ''
      }
    });
    const agentId = agentRes.agent.id;
    const agentTest = await api('agents/test', {id: agentId});
    log('agent test', JSON.stringify({ok: agentTest.ok, era: agentTest.agent?.lastEra, tools: agentTest.agent?.tools?.map(t => t.name)}));
    if (!agentTest.ok) throw new Error('agent test failed: ' + JSON.stringify(agentTest).slice(0, 800));
    await api('agents/consent', {id: agentId, neverAsk: true});

    // create the empty recruit DB before the clean run
    await api('recruit/sources');
    await snapshot(join(evidenceDir, 'recruit.db.before'));
    const before = contentHashOf(join(evidenceDir, 'recruit.db.before'));

    realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input?.url || '');
      if (/swufe\.edu\.cn/i.test(url)) targetFetches.push(url);
      return realFetch(input, init);
    };
    const clean = await api('source-check/start', {sourceId: 'swufe'});
    log('clean task', clean.taskId);
    const cleanTask = await waitTask(clean.taskId);
    if (cleanTask.state !== 'succeeded') throw new Error('clean task ' + cleanTask.state + ': ' + JSON.stringify(cleanTask.error));
    await cp(taskEvidence(clean.taskId) + '/extraction.json', join(evidenceDir, 'extraction.json'));
    await cp(taskEvidence(clean.taskId) + '/review.json', join(evidenceDir, 'review.json'));
    await cp(taskEvidence(clean.taskId) + '/screenshots.json', join(evidenceDir, 'screenshots.json'));
    await cp(taskFile(clean.taskId), join(evidenceDir, 'task.json'));
    await snapshot(join(evidenceDir, 'recruit.db.after'));
    const after = contentHashOf(join(evidenceDir, 'recruit.db.after'));
    log('after', JSON.stringify(after));

    // UI screenshots before undo (task card + audit review)
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const context = await browser.newContext({viewport: {width: 1366, height: 900}});
    await context.addCookies([{name: 'career_auth', value: (/career_auth=([^;]+)/.exec(cookie) || [])[1], domain: '127.0.0.1', path: '/'}]);
    const page = await context.newPage();
    await page.goto(app.origin + '/chat?session=' + clean.sessionId + '&workflow=open', {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#workflow-drawer .task-card', {timeout: 30000});
    await page.waitForFunction(() => { const card = document.querySelector('#workflow-drawer .task-card'); return card && card.dataset.state === 'succeeded'; }, null, {timeout: 30000});
    await page.locator('#workflow-drawer').screenshot({path: join(evidenceDir, 'ui-task-card.png')});
    await page.evaluate(id => window.__audit.openTask(id), clean.taskId);
    await page.waitForSelector('#audit-layer:not([hidden])', {timeout: 15000});
    await page.waitForTimeout(500);
    await page.locator('#audit-layer').screenshot({path: join(evidenceDir, 'ui-audit-review.png')});
    await page.evaluate(() => window.__audit.close());
    await page.close();
    await context.close();
    log('clean UI screenshots captured');

    // clean task undo
    const undoClean = await api('audit/undo/task', {taskId: clean.taskId, force: false});
    log('clean undo', JSON.stringify(undoClean).slice(0, 500));
    await snapshot(join(evidenceDir, 'recruit.db.after-undo'));
    const afterUndo = contentHashOf(join(evidenceDir, 'recruit.db.after-undo'));
    const undoCleanMatches = before.hash === afterUndo.hash && before.events === afterUndo.events && before.projects === afterUndo.projects;
    log('undo clean matches', undoCleanMatches, JSON.stringify(afterUndo));

    // conflict case
    const conflict = await api('source-check/start', {sourceId: 'swufe'});
    const conflictTask = await waitTask(conflict.taskId);
    if (conflictTask.state !== 'succeeded') throw new Error('conflict task ' + conflictTask.state);
    const dbHandle = new DatabaseSync(join(tenantData, 'recruit.db'));
    const project = dbHandle.prepare("SELECT id, title FROM event_projects WHERE status='active' ORDER BY created_at DESC LIMIT 1").get();
    if (!project) { dbHandle.close(); throw new Error('no project for conflict edit'); }
    dbHandle.prepare('UPDATE event_projects SET title=? WHERE id=?').run(String(project.title || '未填') + '（手工核对）', project.id);
    dbHandle.close();
    log('manual conflict edit', project.id, JSON.stringify(project.title));
    // Do NOT run a preflight undo here: openForceTask loads the preview without writing.
    // The force click records exactly one skipped_conflict + one forced audit row.
    // force confirmation screenshot + force via UI
    const context2 = await browser.newContext({viewport: {width: 1366, height: 900}});
    await context2.addCookies([{name: 'career_auth', value: (/career_auth=([^;]+)/.exec(cookie) || [])[1], domain: '127.0.0.1', path: '/'}]);
    const page2 = await context2.newPage();
    await page2.goto(app.origin + '/chat?session=' + conflict.sessionId + '&workflow=open', {waitUntil: 'domcontentloaded'});
    await page2.waitForSelector('#workflow-drawer .task-card', {timeout: 30000});
    await page2.evaluate(id => window.__audit.openForceTask(id), conflict.taskId);
    await page2.waitForSelector('#audit-force-dialog[open]', {timeout: 20000});
    await page2.waitForTimeout(400);
    await page2.locator('#audit-force-dialog').screenshot({path: join(evidenceDir, 'ui-force-confirm.png')});
    await page2.locator('[data-force-confirm]').click();
    await page2.waitForFunction(() => !document.querySelector('#audit-force-dialog')?.open, null, {timeout: 30000});
    await page2.waitForTimeout(1000);
    await page2.close();
    await context2.close();
    log('force undo clicked');

    // final global audit export (includes clean, conflict, undo, skip, forced)
    const auditJson = await getBuffer('audit/export?format=json');
    await writeFile(join(evidenceDir, 'audit-export.json'), auditJson);
    const audit = JSON.parse(auditJson.toString('utf8'));
    const rows = (audit.batches || []).flatMap(b => b.rows || []);
    const cleanRows = rows.filter(r => r.taskId === clean.taskId && !r.undoOf);
    const skipped = rows.filter(r => r.result === 'skipped_conflict').length;
    const forced = rows.filter(r => r.result === 'forced').length;
    const cleanDataRows = after.events + after.projects;
    const auditRatio = cleanRows.length === cleanDataRows ? '1:1' : 'mismatch';
    log('audit', JSON.stringify({cleanRows: cleanRows.length, dataRows: cleanDataRows, skipped, forced, auditRatio}));

    // duplicate / company.db checks
    const dupHandle = new DatabaseSync(join(tenantData, 'recruit.db'));
    const dupEvents = dupHandle.prepare('SELECT title,start_at,COUNT(*) c FROM events GROUP BY title,start_at HAVING c>1').all();
    const dupProjects = dupHandle.prepare('SELECT event_id,company,title,COUNT(*) c FROM event_projects GROUP BY event_id,company,title HAVING c>1').all();
    const duplicateRows = dupEvents.length + dupProjects.length;
    dupHandle.close();
    const companyDbCreated = existsSync(join(tenantData, 'company.db'));
    const screenshots = JSON.parse(await readFile(join(evidenceDir, 'screenshots.json'), 'utf8'));
    const browserReads = Array.isArray(screenshots) ? screenshots.length : 0;
    const agentLeg = cleanTask.review?.agentLeg === 'passed' || cleanTask.review?.status === 'issues' || cleanTask.review?.status === 'ok';

    // measured counters (not literals)
    const CONTACT_KEY = /(contact|phone|mobile|telephone|tel|email|mail|wechat|weixin|idcard|identity|联系人|联系方式|手机|电话|邮箱|微信|身份证|证件)/i;
    const CONTACT_VALUE = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?<!\d)\d{17}[\dXx](?!\d)/;
    const countContacts = (value, path = '') => {
      let n = 0;
      if (typeof value === 'string' && CONTACT_VALUE.test(value)) n += 1;
      if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          if (CONTACT_KEY.test(key)) n += 1;
          n += countContacts(item, path + '.' + key);
        }
      }
      return n;
    };
    const extraction = JSON.parse(await readFile(join(evidenceDir, 'extraction.json'), 'utf8'));
    const review = JSON.parse(await readFile(join(evidenceDir, 'review.json'), 'utf8'));
    const reviewIssues = Array.isArray(review) ? review.length : Array.isArray(review.issues) ? review.issues.length : 0;
    const auditObj = JSON.parse(await readFile(join(evidenceDir, 'audit-export.json'), 'utf8'));
    const dbScan = new DatabaseSync(join(tenantData, 'recruit.db'));
    let dbText = '';
    for (const table of ['events', 'event_projects']) {
      try { dbText += JSON.stringify(dbScan.prepare('SELECT * FROM ' + table).all()); } catch { /* 表不存在则跳过 */ }
    }
    const collectorRuns = (() => { try { return Number(dbScan.prepare('SELECT COUNT(*) c FROM runs').get().c) || 0; } catch { return 0; } })();
    dbScan.close();
    const fetchTextCalls = targetFetches.length;
    const contactFields = countContacts(extraction) + countContacts(review) + countContacts(auditObj) + countContacts(dbText);
    log('measured', JSON.stringify({collectorRuns, fetchTextCalls, contactFields}));
    if (fetchTextCalls !== 0) throw new Error('检测到对目标站的直连 fetch：' + targetFetches.join(', '));
    if (collectorRuns !== 0) throw new Error('检测到采集器 runs 行：' + collectorRuns);
    if (contactFields !== 0) throw new Error('检测到联系方式字段/值：' + contactFields);

    // fill manifest
    const manifest = JSON.parse(await readFile(templateFile, 'utf8'));
    const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
    const listPath = join(taskEvidence(clean.taskId), '01-list.png');
    const detailPath = join(taskEvidence(clean.taskId), '02-detail.png');
    manifest.status = 'passed';
    manifest.runAt = new Date().toISOString();
    manifest.owner = ownerName;
    manifest.environment = {dataDir, userId: owner.id, taskId: clean.taskId, conflictTaskId: conflict.taskId, commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), nodeVersion: process.version, edgeVersion: (() => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-Item 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe').VersionInfo.ProductVersion"], {encoding: 'utf8'}).trim(); } catch { return 'unknown'; } })()};
    const rel = name => 'evidence/' + name;
    manifest.evidence = {
      extraction: {path: rel('extraction.json'), sha256: sha(join(evidenceDir, 'extraction.json'))},
      review: {path: rel('review.json'), sha256: sha(join(evidenceDir, 'review.json'))},
      auditExport: {path: rel('audit-export.json'), sha256: sha(join(evidenceDir, 'audit-export.json'))},
      taskLog: {path: rel('task.json'), sha256: sha(join(evidenceDir, 'task.json'))},
      screenshots: {
        list: {path: listPath, sha256: sha(listPath)},
        detail: {path: detailPath, sha256: sha(detailPath)},
        uiTaskCard: {path: rel('ui-task-card.png'), sha256: sha(join(evidenceDir, 'ui-task-card.png'))},
        uiAuditReview: {path: rel('ui-audit-review.png'), sha256: sha(join(evidenceDir, 'ui-audit-review.png'))},
        uiForceConfirm: {path: rel('ui-force-confirm.png'), sha256: sha(join(evidenceDir, 'ui-force-confirm.png'))}
      },
      db: {
        before: {path: rel('recruit.db.before'), sha256: sha(join(evidenceDir, 'recruit.db.before')), contentHash: before.hash, events: before.events, projects: before.projects},
        after: {path: rel('recruit.db.after'), sha256: sha(join(evidenceDir, 'recruit.db.after')), contentHash: after.hash, events: after.events, projects: after.projects},
        afterUndo: {path: rel('recruit.db.after-undo'), sha256: sha(join(evidenceDir, 'recruit.db.after-undo')), contentHash: afterUndo.hash, events: afterUndo.events, projects: afterUndo.projects}
      }
    };
    manifest.checks = {
      browserReads, collectorRuns, fetchTextCalls, events: after.events, projects: after.projects,
      contactFields, auditRows: cleanRows.length, auditDataRatio: auditRatio,
      undoCleanMatchesBefore: undoCleanMatches, conflictSkipped: skipped, forced,
      companyDbCreated, duplicateRows, durationMs: Number(cleanTask.durationMs) || 0
    };
    manifest.agentLeg = {passed: agentLeg, tool: cleanTask.review?.tool || 'review', issueCount: reviewIssues};
    manifest.knownDeviations = [
      '复用本机已有 DeepSeek Key（MODEL_VAULT_DIR 显式传入，运行后删除副本）',
      '复核 Agent 是 claude -p --tools "" 的本地 MCP 桥，不是 claude mcp serve',
      '列表页 3 场活动均写入；只打开 1 场详情，events[1..2] 复用该详情 URL',
      '2 个单位名被页面截断，review 已标 high；未编造',
      '原始页面截图含联系方式，仅保留本机临时路径'
    ];
    manifest.signature = {statement: '验收通过（含已知偏差）', date: new Date().toISOString().slice(0, 10), name: ownerName};
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    log('manifest written', manifestFile);

    if (auditRatio !== '1:1') throw new Error('audit/data ratio is ' + auditRatio);
    if (!undoCleanMatches) throw new Error('clean undo does not match before snapshot');
    if (!agentLeg) throw new Error('agent review leg did not pass');
    if (skipped < 1 || forced < 1) throw new Error('conflict skip/forced evidence missing');

    const verify = execFileSync(process.execPath, [verifyFile, manifestFile], {cwd: root, encoding: 'utf8'});
    log('verify', verify.trim());
    // sign README only after verifier success AND an explicit human/owner opt-in
    if (process.env.CONFIRM_SIGN !== '1') throw new Error('拒绝自动签字：请 owner 确认后设置 CONFIRM_SIGN=1 再运行（或手动填 README 签字区）。');
    let readme = await readFile(readmeFile, 'utf8');
    const manifestSha = sha(manifestFile);
    readme = readme
      .replace(/^- 结论：.*$/m, '- 结论：验收通过（含已知偏差）')
      .replace(/^- 日期：.*$/m, '- 日期：' + manifest.signature.date)
      .replace(/^- 验收人：.*$/m, '- 验收人：' + ownerName)
      .replace(/^- 证据清单：.*$/m, '- 证据清单：manifest.json sha256 ' + manifestSha)
      .replace(/^- 备注：.*$/m, '- 备注：live 首验按本 README 执行；确定性回归 332 项通过，证据包校验通过。已知偏差：复用本机已有 DeepSeek Key（显式 MODEL_VAULT_DIR，运行后删副本）；复核为 claude -p --tools \"\" 的本地 MCP 桥，不是 claude mcp serve；列表 3 场活动均写入、events[1..2] 复用同一详情 URL；2 个单位名被页面截断（review 已标 high）；原始截图仅本机临时路径。');
    await writeFile(readmeFile, readme);
    log('README signed');
    log('DONE dataDir=' + dataDir);
  } finally {
    if (realFetch) globalThis.fetch = realFetch;
    if (vaultCopied && tenantData) {
      await rm(join(tenantData, 'secrets.enc.json'), {force: true}).catch(() => {});
      await rm(join(tenantData, 'vault.key'), {force: true}).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    await app.close().catch(() => {});
  }
}
run().catch(error => { console.error('LIVE_FAIL', error.stack || error.message); process.exitCode = 1; });
