// 微信公众号 AI 操作员首个原型（#59）。
// 复用 #55 的 operator 任务：可见 profile → 打开公众号文章列表 → 逐篇打开正文 → 抽取 → 写网关/审计 → feed。
// 只写文章里实际读到的单位与时间：没有单位、没有合法 startAt、日期/时间在正文里找不到的文章一律不写。
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {WeChatStore} from './store.mjs';
import {RecruitStore} from '../recruit/store.mjs';
import {publishArticle, isValidStartAt} from './publish.mjs';
import {analyzeArticle} from './analyze.mjs';
import {accountNameKey, canonicalArticleUrl, isWechatArticleUrl} from './identity.mjs';
import {executeOperatorPlan, OperatorError, operatorProfileDir} from '../source-check/operator.mjs';
import {evidenceDirFor, evidenceUrl} from '../source-check/pipeline.mjs';
import {sanitizeRawText} from '../recruit/feed.mjs';

export const WECHAT_OPERATOR_TOOL = 'career_wechat_operator_write';
export const WECHAT_OPERATOR_SCHEMA = 'wechat_operator.v1';
export const WECHAT_ARTICLE_LIMIT = 5;
export const WECHAT_PREFERRED_ACCOUNTS = ['西财校招', '西财就业', '上海财经大学就业', '上财就业'];
export const WECHAT_LIST_EVIDENCE = 'wechat-list.json';
export const WECHAT_SUMMARY_EVIDENCE = 'wechat-operator.json';

export function wechatArticleEvidenceFile(index) {
  return 'wechat-article-' + String(Number(index) || 0).padStart(3, '0') + '.json';
}

// 账号优先级：西财校招（含旧名西财就业）> 上财就业；不做模糊猜测。
export function pickWechatOperatorAccount(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  for (const preferred of WECHAT_PREFERRED_ACCOUNTS) {
    const key = accountNameKey(preferred);
    const hit = list.find(account => accountNameKey(account?.name) === key
      || (Array.isArray(account?.aliasNames) && account.aliasNames.some(name => accountNameKey(name) === key)));
    if (hit) return hit;
  }
  return null;
}

// 公众号主页就是文章列表入口；biz 是公开标识，不需要 cookie/密码。
export function wechatProfileUrl(account = {}) {
  const params = new URLSearchParams({action: 'home', scene: '124'});
  if (account.biz) params.set('__biz', String(account.biz));
  return 'https://mp.weixin.qq.com/mp/profile_ext?' + params.toString() + '#wechat_redirect';
}

// 只保留真正的公众号文章链接（/s 或 /s/<slug>），去掉追踪参数并按规范化链接去重。
export function normalizeWechatOperatorArticles(items, {limit = WECHAT_ARTICLE_LIMIT} = {}) {
  const max = Math.max(1, Math.min(20, Number(limit) || WECHAT_ARTICLE_LIMIT));
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const raw = typeof item === 'string' ? item : item?.url;
    const url = canonicalArticleUrl(raw);
    if (!url || !isWechatArticleUrl(url)) continue;
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { continue; }
    if (!/^\/s(\/|$)/.test(pathname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({url, title: String(typeof item === 'object' ? item?.title || '' : '').trim().slice(0, 200)});
    if (out.length >= max) break;
  }
  return out;
}

// 页面读取器是唯一依赖真实浏览器的接缝：测试注入 fixture，不访问微信网络。
const WECHAT_LOGIN_WALL = /(登录|扫码|微信公众平台|请在微信客户端|环境异常|安全验证|验证码)/;

export async function readWechatArticleList({page} = {}) {
  try { await page.waitForTimeout?.(1200); } catch { /* 页面已就绪或假页面不支持 */ }
  // 文章列表常在滚动后懒加载；只在同一页内滚动，不翻页、不并发。
  try {
    await page.evaluate(() => window.scrollBy(0, 1600));
    await page.waitForTimeout?.(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch { /* 不支持滚动的页面直接读取当前视口 */ }
  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')]
      .map(anchor => ({url: anchor.href || '', title: (anchor.innerText || anchor.textContent || '').trim()}))
      .filter(item => /mp\.weixin\.qq\.com\/s(\?|\/|$)/.test(item.url));
    return {title: document.title || '', text: String(document.body?.innerText || '').slice(0, 4000), links};
  });
  const title = String(info?.title || '');
  const text = String(info?.text || '');
  const links = Array.isArray(info?.links) ? info.links : [];
  if (!links.length && WECHAT_LOGIN_WALL.test(title + ' ' + text)) {
    throw new OperatorError('OPERATOR_LOGIN_REQUIRED', '公众号文章列表需要登录或验证，请在本窗口登录后点「已登录，继续」。', '不要绕过微信验证。');
  }
  return links;
}

export async function readWechatArticleBody({page} = {}) {
  try { await page.waitForTimeout?.(800); } catch { /* 同上 */ }
  const info = await page.evaluate(() => {
    const pick = selector => document.querySelector(selector)?.innerText || '';
    const text = String(pick('#js_content') || document.body?.innerText || '').slice(0, 20000);
    return {
      title: (pick('#activity-name') || pick('.rich_media_title') || document.title || '').trim().slice(0, 200),
      nickname: (pick('#js_name') || pick('.profile_nickname') || '').trim().slice(0, 80),
      publishedAt: (pick('#publish_time') || '').trim().slice(0, 40),
      text
    };
  });
  if (String(info?.text || '').trim().length < 120 && WECHAT_LOGIN_WALL.test(String(info?.title || '') + ' ' + String(info?.text || ''))) {
    throw new OperatorError('OPERATOR_LOGIN_REQUIRED', '文章正文需要登录或验证，请在本窗口处理后点「已登录，继续」。', '不要绕过微信验证。');
  }
  return info;
}

export function createWechatPageReaders() {
  return {list: readWechatArticleList, article: readWechatArticleBody};
}

// 运行时计划：先打开文章列表并读取链接，再按读到的文章逐篇打开正文。
// playwright 步骤返回的后续步骤由 operator 核心插入当前计划（见 #55 的运行时追加）。
export function buildWechatOperatorPlan({account, limit = WECHAT_ARTICLE_LIMIT, readers = createWechatPageReaders(), collected = {list: [], bodies: []}} = {}) {
  const listUrl = wechatProfileUrl(account);
  return [
    {action: 'goto', url: listUrl, label: '公众号文章列表'},
    {
      action: 'playwright',
      label: '读取公众号文章列表',
      perform: async ({page}) => {
        const raw = await readers.list({page, account});
        const articles = normalizeWechatOperatorArticles(raw, {limit});
        collected.list = articles;
        const steps = [];
        for (const article of articles) {
          steps.push({action: 'goto', url: article.url, label: '打开文章：' + (article.title || article.url)});
          steps.push({
            action: 'playwright',
            label: '读取文章正文：' + (article.title || article.url),
            perform: async ({page: target}) => {
              const body = await readers.article({page: target, article, account});
              collected.bodies.push({article, body});
            }
          });
        }
        return steps;
      }
    }
  ];
}

function dateGrounded(text, startAt) {
  const [year, month, day] = String(startAt || '').slice(0, 10).split('-');
  if (!year || !month || !day) return false;
  const y = Number(year), m = Number(month), d = Number(day);
  const patterns = [
    year + '年' + m + '月' + d + '日',
    year + '-' + month + '-' + day,
    year + '.' + m + '.' + d,
    year + '/' + m + '/' + d,
    m + '月' + d + '日'
  ];
  return patterns.some(pattern => String(text || '').includes(pattern));
}

function timeGrounded(text) {
  return /\d{1,2}\s*[:：]\s*\d{2}/.test(String(text || '')) || /\d{1,2}\s*[点时]/.test(String(text || ''));
}

function normalized(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

// 0 编造：单位名必须能在正文里找到；只剩正文里找到的单位才允许写库。
export function groundWechatProjects(projects, {title = '', text = ''} = {}) {
  const haystack = normalized(String(title || '') + '\n' + String(text || ''));
  return (Array.isArray(projects) ? projects : []).filter(project => {
    const company = normalized(project?.company);
    const projectTitle = normalized(project?.title);
    if (company) return haystack.includes(company);
    return !!projectTitle && haystack.includes(projectTitle);
  });
}

// 写库门禁：至少 1 个单位 + 合法 startAt + 日期/时间确实来自正文，否则跳过而不是补造。
export function evaluateWechatArticle({title = '', text = '', analysis = {}} = {}) {
  const body = String(text || '');
  const projects = Array.isArray(analysis.projects) ? analysis.projects : [];
  if (body.trim().length < 120) return {ok: false, reason: 'text_too_short', analysis};
  if (analysis.hasRecruitment === 'no') return {ok: false, reason: 'not_recruitment', analysis};
  const grounded = groundWechatProjects(projects, {title, text: body});
  const warnings = Array.isArray(analysis.warnings) ? [...analysis.warnings] : [];
  const removed = projects.length - grounded.length;
  if (removed > 0) warnings.push('已剔除正文中找不到的单位/项目 ' + removed + ' 个');
  if (!grounded.length) return {ok: false, reason: 'no_units', analysis: {...analysis, projects: [], warnings}};
  const startAt = String(analysis?.draft?.startAt || '');
  if (!isValidStartAt(startAt)) return {ok: false, reason: 'invalid_start_at', analysis: {...analysis, projects: grounded, warnings}};
  if (!dateGrounded(body, startAt)) return {ok: false, reason: 'start_at_not_in_article', analysis: {...analysis, projects: grounded, warnings}};
  if (!timeGrounded(body)) return {ok: false, reason: 'time_not_in_article', analysis: {...analysis, projects: grounded, warnings}};
  return {ok: true, analysis: {...analysis, projects: grounded, warnings}};
}

function firstLine(value) {
  return String(value || '').split('\n').map(line => line.trim()).find(Boolean) || '';
}

function normalizedArticle(article, body = {}) {
  const url = canonicalArticleUrl(article?.url);
  const text = String(body?.text || '').trim().slice(0, 20000);
  const title = String(body?.title || article?.title || firstLine(text) || '').trim().slice(0, 200);
  return {
    url,
    title,
    text,
    nickname: String(body?.nickname || '').trim().slice(0, 80),
    publishedAt: String(body?.publishedAt || '').trim().slice(0, 40)
  };
}

// 操作员任务主体：operator 读列表/正文 → 入库/分析 → 门禁 → 写网关/审计 → 证据。
export async function runWechatOperator({
  dataDir, userId, task, account, wechatDir,
  limit = WECHAT_ARTICLE_LIMIT,
  readers = createWechatPageReaders(),
  launch,
  maxActiveMs,
  signal,
  emit = () => {},
  addEvidence = async () => {},
  setPhase = () => {},
  askHuman,
  analyze = analyzeArticle,
  store,
  recruitStore,
  now = () => new Date()
} = {}) {
  if (!dataDir) throw new Error('公众号操作需要 dataDir');
  if (!userId) throw new Error('公众号操作需要用户身份');
  if (!task?.id) throw new Error('公众号操作需要任务 id');
  if (!account?.id) throw new Error('公众号操作需要公众号账号');
  if (!wechatDir) throw new Error('公众号操作需要公众号数据目录');
  const taskId = String(task.id);
  const evidenceDir = evidenceDirFor(dataDir, userId, taskId);
  await mkdir(evidenceDir, {recursive: true});
  const collected = {list: [], bodies: []};
  const plan = buildWechatOperatorPlan({account, limit, readers, collected});
  setPhase('正在打开公众号文章列表…');
  const operator = await executeOperatorPlan({
    profileDir: operatorProfileDir(dataDir, userId),
    evidenceDir,
    taskId,
    steps: plan,
    source: {id: 'wechat:' + account.id, name: account.name, school: account.school || ''},
    launch,
    maxActiveMs,
    signal,
    emit,
    addEvidence,
    setPhase,
    askHuman
  });

  if (!collected.list.length) {
    throw new OperatorError('WECHAT_NO_ARTICLES', '公众号文章列表没有读到文章链接。', '在可见窗口登录并打开公众号后重试；或改用文章链接手动导入。');
  }

  const fetchedAt = now().toISOString();
  await writeFile(join(evidenceDir, WECHAT_LIST_EVIDENCE), JSON.stringify({
    schema_version: WECHAT_OPERATOR_SCHEMA,
    kind: 'wechat_article_list',
    account: {id: account.id, name: account.name, school: account.school || '', biz: account.biz || ''},
    source_url: wechatProfileUrl(account),
    fetched_at: fetchedAt,
    articles: collected.list
  }, null, 2), 'utf8');
  await addEvidence({
    kind: 'wechat_list',
    label: '公众号文章列表：' + collected.list.length + ' 篇',
    detail: collected.list.map((article, index) => (index + 1) + '. ' + (article.title || article.url)).join('；').slice(0, 1000),
    url: evidenceUrl(taskId, WECHAT_LIST_EVIDENCE)
  });

  const ownStore = !store;
  const ws = store || WeChatStore.open(join(wechatDir, 'wechat.db'));
  let rs = recruitStore || null;
  const ownRecruit = !recruitStore;
  const ensureRecruit = () => rs || (rs = RecruitStore.open(join(wechatDir, 'recruit.db')));
  const published = [];
  const skipped = [];
  let written = 0;
  try {
    for (let index = 0; index < collected.bodies.length; index += 1) {
      const entry = collected.bodies[index];
      const article = normalizedArticle(entry?.article, entry?.body);
      const evidenceFile = wechatArticleEvidenceFile(index + 1);
      if (!article.url || !article.title || !article.text) {
        skipped.push({title: article.title || article.url, url: article.url, reason: 'unreadable_article'});
        continue;
      }
      setPhase('正在解析公众号文章：' + article.title.slice(0, 40));
      let saved = null;
      try {
        const owner = ws.resolveAccount({biz: String(entry?.body?.biz || ''), nickname: article.nickname, title: article.title, text: article.text, school: account.school || ''}) || account;
        saved = ws.saveArticle({
          accountId: owner?.id || account.id,
          title: article.title,
          url: article.url,
          publishedAt: article.publishedAt,
          summary: article.text.slice(0, 300),
          content: article.text,
          nickname: article.nickname,
          biz: String(entry?.body?.biz || '')
        });
      } catch (error) {
        skipped.push({title: article.title, url: article.url, reason: 'save_failed', message: String(error?.message || error).slice(0, 300)});
        continue;
      }

      const analysis = analyze({title: saved.title, text: article.text, url: saved.url});
      const gate = evaluateWechatArticle({title: saved.title, text: article.text, analysis});
      ws.saveAnalysis(saved.id, gate.analysis || analysis);

      const record = {
        schema_version: WECHAT_OPERATOR_SCHEMA,
        source_id: 'wechat:' + (saved.accountId || account.id),
        source_url: saved.url,
        fetched_at: fetchedAt,
        confidence: 0.6,
        account: {id: account.id, name: account.name, school: account.school || ''},
        article: {id: saved.id, title: saved.title, published_at: saved.publishedAt || '', nickname: saved.nickname || ''},
        analysis: {hasRecruitment: gate.analysis?.hasRecruitment || '', draft: gate.analysis?.draft || {}, projects: gate.analysis?.projects || [], warnings: gate.analysis?.warnings || []},
        content: sanitizeRawText(article.text),
        published: null,
        skipped: null
      };

      if (!gate.ok) {
        record.skipped = {reason: gate.reason};
        await writeFile(join(evidenceDir, evidenceFile), JSON.stringify(record, null, 2), 'utf8');
        skipped.push({title: saved.title, url: saved.url, reason: gate.reason});
        await addEvidence({
          kind: 'wechat_article',
          label: '公众号文章未写入（' + gate.reason + '）：' + saved.title.slice(0, 40),
          detail: '缺少可核对的单位或合法开始时间；没有编造数据。来源 ' + saved.url,
          url: evidenceUrl(taskId, evidenceFile)
        });
        continue;
      }

      let outcome = null;
      let failure = '';
      try {
        outcome = await publishArticle({
          dir: wechatDir,
          articleId: saved.id,
          store: ws,
          recruitStore: ensureRecruit(),
          analyze: () => gate.analysis,
          audit: {
            userId, actorType: 'model', actorRef: 'wechat-operator', taskId,
            tool: WECHAT_OPERATOR_TOOL,
            idempotencyKey: 'wechat-operator:' + taskId + ':' + saved.id,
            sourceRef: 'artifact:' + evidenceFile
          }
        });
      } catch (error) {
        failure = String(error?.message || error).slice(0, 300);
      }
      if (!outcome?.ok) {
        record.skipped = {reason: 'publish_failed', message: failure || outcome?.reason || ''};
        await writeFile(join(evidenceDir, evidenceFile), JSON.stringify(record, null, 2), 'utf8');
        skipped.push({title: saved.title, url: saved.url, reason: failure ? 'publish_failed' : (outcome?.reason || 'publish_failed'), message: failure});
        await addEvidence({
          kind: 'wechat_article',
          label: '公众号文章写入失败：' + saved.title.slice(0, 40),
          detail: failure || outcome?.reason || '写入未完成；没有补造数据。',
          url: evidenceUrl(taskId, evidenceFile)
        });
        continue;
      }

      const projectCount = Array.isArray(outcome.projects) ? outcome.projects.length : 0;
      const rows = outcome.duplicate ? 0 : 1 + projectCount;
      written += rows;
      record.published = {
        event_id: outcome.event?.id || '',
        batch_id: outcome.batchId || '',
        project_count: projectCount,
        duplicate: !!outcome.duplicate
      };
      await writeFile(join(evidenceDir, evidenceFile), JSON.stringify(record, null, 2), 'utf8');
      published.push({
        articleId: saved.id,
        title: saved.title,
        url: saved.url,
        eventId: outcome.event?.id || '',
        batchId: outcome.batchId || '',
        projectCount,
        duplicate: !!outcome.duplicate
      });
      await addEvidence({
        kind: 'wechat_article',
        label: '公众号文章已写入：' + saved.title.slice(0, 40),
        detail: '活动 1 条 · 单位 ' + projectCount + ' 条 · 来源 ' + saved.url,
        url: evidenceUrl(taskId, evidenceFile)
      });
      if (!outcome.duplicate) {
        emit({
          type: 'writes', taskId, tool: WECHAT_OPERATOR_TOOL, batchId: outcome.batchId || '',
          counts: {rows: 1 + projectCount, created: 1 + projectCount, updated: 0, deleted: 0, skipped: 0}
        });
      }
    }

    const summary = {
      schema_version: WECHAT_OPERATOR_SCHEMA,
      task_id: taskId,
      account: {id: account.id, name: account.name},
      source_url: wechatProfileUrl(account),
      fetched_at: fetchedAt,
      actions: operator.actions?.length || 0,
      screenshots: operator.screenshots?.length || 0,
      written,
      published,
      skipped
    };
    await writeFile(join(evidenceDir, WECHAT_SUMMARY_EVIDENCE), JSON.stringify(summary, null, 2), 'utf8');
    await addEvidence({
      kind: 'wechat_summary',
      label: '公众号操作完成：写入 ' + written + ' 条记录',
      detail: '已写入 ' + published.length + ' 篇；跳过 ' + skipped.length + ' 篇。',
      url: evidenceUrl(taskId, WECHAT_SUMMARY_EVIDENCE)
    });
    setPhase('公众号操作完成：写入 ' + written + ' 条记录（活动 + 单位）。');
    return {
      ok: true,
      articles: collected.list.length,
      written,
      published,
      skipped,
      actions: operator.actions?.length || 0,
      screenshots: operator.screenshots?.length || 0
    };
  } finally {
    if (ownRecruit) { try { rs?.close(); } catch { /* 已关闭 */ } }
    if (ownStore) { try { ws?.close(); } catch { /* 已关闭 */ } }
  }
}
