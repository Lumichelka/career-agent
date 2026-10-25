import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = new URL('./index.html', import.meta.url).href;
const dir = path.dirname(fileURLToPath(import.meta.url));
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe });
const shots = [
  ['A-desktop-modern','variant=A&state=modern',1440,950],
  ['A-desktop-config','variant=A&state=modern&pane=config',1440,950],
  ['A-desktop-http','variant=A&state=native&agent=dify&pane=config',1440,950],
  ['A-desktop-failed','variant=A&state=failed-auth',1440,950],
  ['A-desktop-empty','variant=A&state=empty',1440,950],
  ['A-mobile-list','variant=A&state=modern&screen=list',390,844],
  ['A-mobile-detail','variant=A&state=modern&screen=detail',390,844],
  ['B-desktop-list','variant=B&state=native',1440,950],
  ['B-desktop-detail','variant=B&state=discovery-failed&view=detail',1440,950],
  ['B-desktop-edit','variant=B&state=modern&view=detail&edit=1',1440,950],
  ['B-mobile-detail','variant=B&state=legacy&view=detail',390,844],
  ['C-desktop-runtime','variant=C&state=queued&view=detail',1440,950],
  ['C-desktop-settings','variant=C&state=native&settings=1',1440,950],
  ['C-mobile-runtime','variant=C&state=recycled&view=detail',390,844]
];
for (const [name, qs, w, h] of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.goto(base + '?' + qs, { waitUntil: 'load' });
  await page.waitForTimeout(450);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: path.join(dir, 'screenshots', name + '.png') });
  console.log(name, 'overflow=' + overflow, errs.length ? 'ERR ' + errs.join(' | ') : 'ok');
  await page.close();
}
await browser.close();
