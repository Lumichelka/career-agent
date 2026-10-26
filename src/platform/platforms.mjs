import {chromium} from 'playwright';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {PLATFORM_SITES, PLATFORM_IDS, siteById, isPlatformId, siteUrlAllowed} from './sites.mjs';
import {ocrImage} from './ocr.mjs';

export const PLATFORMS = PLATFORM_SITES;
export {PLATFORM_IDS, PLATFORM_SITES};

export function validatePlatform(id) {
  if (!isPlatformId(id)) throw new Error('不支持的网站');
  return siteById(id);
}

// 白名单实现放在 sites.mjs，岗位入库模块也要用同一份判断，避免两处漂移。
export function allowedPlatformUrl(id, raw) {
  validatePlatform(id);
  return siteUrlAllowed(id, raw);
}

export function searchUrl(id, query) {
  const site = validatePlatform(id);
  if (typeof query !== 'string' || !query.trim() || query.length > 120) throw new Error('搜索词需为1至120字，不含个人联系方式');
  if (/\b1[3-9]\d{9}\b|[^\s]+@[^\s]+\.[^\s]+/.test(query)) throw new Error('不要把电话、邮箱放入平台搜索词');
  return site.searchUrl(query.trim());
}

export function readablePath(id, raw) {
  if (!allowedPlatformUrl(id, raw)) return false;
  const site = validatePlatform(id);
  const u = new URL(raw);
  return site.readable.test(u.pathname);
}

export class PlatformBrowser {
  constructor(root) {
    this.root = root;
    this.states = new Map();
    this.locks = new Map();
    this.lastScreenshots = new Map();
    // 最近一次真实读取的页面快照：平台岗位入库只以这份快照为准，避免模型自报岗位。
    this.lastReads = new Map();
  }

  recordRead(id, snapshot) {
    validatePlatform(id);
    this.lastReads.set(id, {
      url: String(snapshot?.url || ''),
      title: String(snapshot?.title || ''),
      text: String(snapshot?.text || ''),
      links: (Array.isArray(snapshot?.links) ? snapshot.links : []).slice(0, 300).map(link => ({title: String(link?.title || ''), url: String(link?.url || '')})),
      at: String(snapshot?.at || new Date().toISOString()),
      status: String(snapshot?.status || '')
    });
  }

  lastRead(id) {
    validatePlatform(id);
    return this.lastReads.get(id) || null;
  }

  async serial(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    this.locks.set(id, result.catch(() => {}));
    return result;
  }

  async #navigate(site, page, url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
      } catch { /* 网络/重定向失败时下面统一判断 */ }
      await page.waitForTimeout(700).catch(() => {});
      if (page.url() && page.url() !== 'about:blank') return {ok: true, page};
      // BOSS 偶尔会先落 about:blank，第二次直接重试；仍失败则新建标签页。
      if (attempt === 1) {
        try {
          const fresh = await page.context().newPage();
          await fresh.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
          await page.close().catch(() => {});
          return {ok: fresh.url() !== 'about:blank', page: fresh};
        } catch { /* 保留原页 */ }
      }
    }
    return {ok: false, page};
  }

  async open(id) {
    return this.serial(id, async () => {
      const site = validatePlatform(id);
      let state = this.states.get(id);
      if (state && state.context && !state.context.isClosed?.()) {
        await state.page.bringToFront().catch(() => {});
        return this.status(id);
      }
      const profile = join(this.root, '.data', 'platform-profiles', id);
      await mkdir(profile, {recursive: true});
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'msedge', headless: false, chromiumSandbox: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
          '--disable-sync', '--disable-features=msEdgeSync,EdgeSync,msEdgeIdentity',
          '--disable-background-networking', '--deny-permission-prompts', '--disable-notifications',
          '--disable-geolocation', '--use-fake-ui-for-media-stream'
        ],
        locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
        viewport: {width: 1180, height: 820}, acceptDownloads: false
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
        window.chrome = window.chrome || {runtime: {}};
      });
      // Edge 首次启动可能弹出同步/权限提示；它们会抢焦点，甚至让页面看起来停在 about:blank。
      await new Promise(r => setTimeout(r, 1200));
      for (const extra of context.pages()) {
        if (/^edge:\/\/(permission-request-dialog|sync-confirmation-dialog)/.test(extra.url())) {
          await extra.close().catch(() => {});
        }
      }
      let page = context.pages().find(p => allowedPlatformUrl(id, p.url())) || context.pages().find(p => !p.url() || p.url() === 'about:blank') || context.pages()[0] || await context.newPage();
      state = {context, page, error: '', openedAt: new Date().toISOString()};
      this.states.set(id, state);
      context.on('close', () => { if (this.states.get(id) === state) this.states.delete(id); });
      const watchBlank = p => {
        p.on('framenavigated', frame => {
          if (frame !== p.mainFrame() || frame.url() !== 'about:blank' || state.recovering) return;
          state.recovering = true;
          setTimeout(async () => {
            try { await this.#navigate(site, state.page, site.home); }
            finally { state.recovering = false; }
          }, 250);
        });
      };
      watchBlank(page);
      context.on('page', popped => {
        // 登录/安全验证可能开新标签：只要它进入本站可读路径，就切换为当前页。
        popped.on('domcontentloaded', () => {
          if (allowedPlatformUrl(id, popped.url()) && readablePath(id, popped.url())) state.page = popped;
        });
      });

      const nav = allowedPlatformUrl(id, page.url()) ? {ok: true, page} : await this.#navigate(site, page, site.home);
      const domainPage = context.pages().find(p => allowedPlatformUrl(id, p.url()));
      if (domainPage && domainPage !== page) {
        page = domainPage;
        state.page = page;
      }
      if (nav.page && nav.page !== page) {
        page = nav.page;
        state.page = page;
      }
      if (!nav.ok) state.error = '页面仍停在 about:blank，可能是网络、学校/公司代理或平台拦截；请重试或改用截图兜底。';
      return this.status(id);
    });
  }

  async status(id) {
    const site = validatePlatform(id), s = this.states.get(id);
    if (!s || !s.page || s.page.isClosed()) return {id, name: site.name, kind: site.kind, state: 'closed', message: '未打开该网站的专用浏览器'};
    let raw = s.page.url();
    if ((!raw || raw === 'about:blank') && !s.recovering) {
      s.recovering = true;
      try {
        const nav = await this.#navigate(site, s.page, site.home);
        if (nav.page && nav.page !== s.page) s.page = nav.page;
        raw = s.page.url();
      } finally { s.recovering = false; }
    }
    const readable = allowedPlatformUrl(id, raw);
    return {
      id, name: site.name, kind: site.kind, state: 'opened',
      message: s.error || '浏览器已打开；请在官方页面完成登录，再检查当前页面。',
      url: readable ? raw : site.home,
      blank: !raw || raw === 'about:blank'
    };
  }

  async statuses() {
    return Promise.all(PLATFORM_IDS.map(id => this.status(id)));
  }

  async capture(id) {
    const site = validatePlatform(id), s = this.states.get(id);
    if (!s || !s.page || s.page.isClosed()) throw new Error('专用浏览器没有打开');
    const dir = join(this.root, '.data', 'platform-screenshots');
    await mkdir(dir, {recursive: true});
    const file = join(dir, id + '.png');
    await s.page.bringToFront().catch(() => {});
    await s.page.screenshot({path: file, fullPage: false});
    this.lastScreenshots.set(id, file);
    return file;
  }

  screenshotPath(id) {
    validatePlatform(id);
    return this.lastScreenshots.get(id) || join(this.root, '.data', 'platform-screenshots', id + '.png');
  }

  async #fallback(id, site, s, reason, data) {
    let file = '';
    try { file = await this.capture(id); } catch { /* 没有截图也能返回原因 */ }
    let ocr = '';
    if (file) {
      const result = await ocrImage(file);
      if (result.ok) ocr = result.text;
    }
    const screenshotUrl = file ? '/api/platform/screenshot/' + id + '?t=' + Date.now() : '';
    if (ocr.trim().length >= 10) {
      return {
        platform: id, name: site.name, status: 'ocr_readable',
        message: reason + '；已切换截图 OCR 读取，结果仍需核对。',
        url: allowedPlatformUrl(id, s.page.url()) ? s.page.url() : site.home,
        title: data.title, text: ocr, screenshotUrl, ocr: true, sources: data.sources
      };
    }
    return {
      platform: id, name: site.name, status: 'needs_manual',
      message: reason + '；已保存页面截图，请本人查看并手动确认。',
      url: allowedPlatformUrl(id, s.page.url()) ? s.page.url() : site.home,
      title: data.title, text: data.text.slice(0, 4000), screenshotUrl, ocr: false, sources: data.sources
    };
  }

  async read(id) {
    return this.serial(id, () => this.#readPage(id));
  }

  // 用户主动点“截图识别”时的兜底：不依赖 DOM，直接把当前页面截图交给本地 OCR。
  async ocr(id) {
    return this.serial(id, async () => {
      const site = validatePlatform(id);
      const s = this.states.get(id);
      if (!s || !s.page || s.page.isClosed()) return {platform: id, name: site.name, status: 'needs_connection', message: '请先打开该网站的专用浏览器。', sources: []};
      const file = await this.capture(id);
      const result = await ocrImage(file);
      const screenshotUrl = '/api/platform/screenshot/' + id + '?t=' + Date.now();
      if (result.ok) {
        return {
          platform: id, name: site.name, status: 'ocr_readable', text: result.text,
          message: '已用当前页面截图做 OCR；文字可能有识别误差，请对照截图核对。',
          url: s.page.url(), screenshotUrl, ocr: true, sources: []
        };
      }
      return {platform: id, name: site.name, status: 'needs_manual', message: 'OCR 不可用：' + result.reason, text: '', screenshotUrl, ocr: false, sources: []};
    });
  }

  async #readPage(id) {
    const site = validatePlatform(id);
    const s = this.states.get(id);
    if (!s || !s.page || s.page.isClosed()) {
      return {platform: id, name: site.name, status: 'needs_connection', message: '请先在“连接网站”里打开该网站并由本人登录。', sources: []};
    }
    if (!s.page.url() || s.page.url() === 'about:blank') {
      const nav = await this.#navigate(site, s.page, site.home);
      if (nav.page && nav.page !== s.page) s.page = nav.page;
      if (!nav.ok) return {platform: id, name: site.name, status: 'load_failed', message: '页面仍是 about:blank，已停止读取；请检查网络/代理后重试。', sources: []};
    }
    const url = s.page.url();
    if (!allowedPlatformUrl(id, url)) {
      return {platform: id, name: site.name, status: 'needs_user', message: '当前不是本站页面。请打开' + site.readHint + '后再读取。', sources: []};
    }
    const hasPassword = await s.page.locator('input[type="password"]:visible').count();
    const hasCode = await s.page.locator('input[autocomplete="one-time-code"]:visible').count();
    if (hasPassword || hasCode || /login|passport|signin/i.test(new URL(url).pathname)) {
      return {platform: id, name: site.name, status: 'needs_login', message: '当前正在登录或验证，请本人完成；智能体不会读取验证码或密码。', sources: []};
    }
    const data = await s.page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 18000),
      links: Array.from(document.querySelectorAll('a[href]')).map(a => ({title: a.innerText.trim().slice(0, 150), url: a.href})).filter(a => a.title).slice(0, 300)
    }));
    if (/安全验证|访问异常|滑块验证|请完成验证|访问受限|验证码/.test(data.text)) {
      return this.#fallback(id, site, s, '平台要求验证或限制了访问，DOM 文本不足以判断', data);
    }
    const sources = data.links.filter(a => allowedPlatformUrl(id, a.url) && site.detail.test(new URL(a.url).pathname)).slice(0, 25);
    const detailPage = site.detail.test(new URL(url).pathname);
    if (detailPage || sources.length) {
      const readAt = new Date().toISOString();
      this.recordRead(id, {url, title: data.title, text: data.text, links: data.links, at: readAt, status: 'readable'});
      return {
        platform: id, name: site.name, status: 'readable',
        message: '以下为浏览器实际显示的文字；页面可读不等于登录已确认，关键信息请核对。',
        url, title: data.title, text: data.text, sources, readAt
      };
    }
    // 没有详情链接、正文又很短：典型的前端渲染未完成/风控页，切换到截图 OCR。
    if (data.text.trim().length < 200) {
      return this.#fallback(id, site, s, '页面正文过少，可能未渲染完成', data);
    }
    const readAt = new Date().toISOString();
    this.recordRead(id, {url, title: data.title, text: data.text, links: data.links, at: readAt, status: 'unconfirmed'});
    return {
      platform: id, name: site.name, status: 'unconfirmed',
      message: '页面可读，但没有识别到明确的' + site.readHint + '；已保留文字供核对。',
      url, title: data.title, text: data.text, sources, readAt
    };
  }

  async search(id, query) {
    return this.serial(id, async () => {
      const url = searchUrl(id, query), s = this.states.get(id);
      if (!s || !s.page || s.page.isClosed()) return {platform: id, name: validatePlatform(id).name, status: 'needs_connection', message: '请先连接网站并本人登录。', sources: []};
      const start = Date.now();
      if (s.lastSearch && start - s.lastSearch < 5000) throw new Error('搜索过快，请稍候再试');
      s.lastSearch = start;
      const site = validatePlatform(id);
      try {
        await s.page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
        await s.page.locator(site.searchWait).first().waitFor({state: 'visible', timeout: 8000}).catch(() => {});
      } catch {
        return this.#fallback(id, site, s, '搜索页面没有正常载入', {title: '', text: '', sources: []});
      }
      return this.#readPage(id);
    });
  }

  // 元素点击：在当前搜索结果里点开第一条详情，再读取详情页。
  async openResult(id) {
    return this.serial(id, async () => {
      const site = validatePlatform(id);
      const s = this.states.get(id);
      if (!s || !s.page || s.page.isClosed()) return {platform: id, name: site.name, status: 'needs_connection', message: '请先连接网站并本人登录。', sources: []};
      const link = s.page.locator(site.searchWait).first();
      let count = 0;
      try { count = await link.count(); } catch { count = 0; }
      if (!count) return this.#fallback(id, site, s, '当前页面没有识别到可点击的结果链接', {title: '', text: '', sources: []});
      try {
        await link.click({timeout: 8000, noWaitAfter: true});
      } catch {
        return this.#fallback(id, site, s, '结果链接点击失败（可能被登录/验证遮挡）', {title: '', text: '', sources: []});
      }
      await s.page.waitForTimeout(1200).catch(() => {});
      const domainPage = s.context.pages().find(p => allowedPlatformUrl(id, p.url()) && readablePath(id, p.url()));
      if (domainPage) s.page = domainPage;
      return this.#readPage(id);
    });
  }

  async probe() {
    const results = await Promise.all(PLATFORM_IDS.map(async id => {
      const site = siteById(id);
      const started = Date.now();
      try {
        const res = await fetch(site.home, {redirect: 'follow', signal: AbortSignal.timeout(12000), headers: {'user-agent': 'Mozilla/5.0 Chrome/125'}});
        return {id, name: site.name, ok: res.ok, status: res.status, url: res.url, ms: Date.now() - started};
      } catch (e) {
        return {id, name: site.name, ok: false, status: 0, reason: e.name || e.message, ms: Date.now() - started};
      }
    }));
    return {message: `${results.filter(r => r.ok).length}/${results.length} 个网站首页可访问；登录态需逐个打开确认。`, results};
  }

  async close(id) {
    validatePlatform(id);
    return this.serial(id, async () => {
      await this.states.get(id)?.context?.close().catch(() => {});
      this.states.delete(id);
      return this.status(id);
    });
  }

  // 某些平台会检测自动化并清空页面（典型是 BOSS 跳到 about:blank）。
  // 此时用系统默认 Edge 打开，至少保证用户能正常登录和阅读；智能体不读取该窗口。
  async openExternal(id) {
    const site = validatePlatform(id);
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', 'msedge', '--profile-directory=Default', site.home], {detached: true, stdio: 'ignore'}).unref();
      return {id, name: site.name, state: 'external', message: '已用系统 Edge 打开 ' + site.name + '；请在普通窗口登录并查看，再用“手动导入”记录内容。'};
    }
    return {id, name: site.name, state: 'external', message: '当前系统不支持自动打开系统浏览器，请手动打开 ' + site.home};
  }
}
