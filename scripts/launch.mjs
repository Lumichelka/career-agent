import {spawn} from 'node:child_process';
import {mkdirSync, openSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolveDataDir} from '../src/config/paths.mjs';
import {join} from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = resolveDataDir();
const port = Number(process.env.PORT || 4189);
const lan = process.argv.includes('--lan') || process.env.CAREER_HOST === '0.0.0.0';
const noOpen = process.argv.includes('--no-open') || process.env.CAREER_NO_OPEN === '1';
const host = lan ? '0.0.0.0' : '127.0.0.1';
const url = 'http://127.0.0.1:' + port;

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => 'http://' + n.address + ':' + port);
}

async function health() {
  try { return await (await fetch(url + '/health', {signal: AbortSignal.timeout(1000)})).json(); } catch { return null; }
}
const ready = async () => (await health())?.app === 'career-agent';

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 23) {
    console.log('当前 Node.js 版本是 ' + process.versions.node + '，本项目需要 23 或更新版本（内置 SQLite）。');
    console.log('请到 https://nodejs.org/ 下载安装最新 LTS 后重试。');
    process.exitCode = 1;
    return;
  }

  if (await ready()) {
    const info = await health();
    if (lan && info.host !== '0.0.0.0') {
      console.log('检测到已有一个只监听本机的职向服务在运行。');
      console.log('请先结束它的 node 进程（任务管理器或 Ctrl+C），再重新双击「开始使用-局域网.cmd」。');
      process.exitCode = 1;
      return;
    }
  } else {
    mkdirSync(dataDir, {recursive: true});
    const env = {...process.env, CAREER_HOST: host};
    const child = spawn(process.execPath, [join(root, 'src', 'server', 'index.mjs')], {
      cwd: root,
      detached: true,
      windowsHide: true,
      env,
      stdio: ['ignore', openSync(join(dataDir, 'server.log'), 'a'), openSync(join(dataDir, 'server-error.log'), 'a')]
    });
    child.unref();
    writeFileSync(join(dataDir, 'server.pid'), String(child.pid));
    for (let i = 0; i < 60 && !await ready(); i++) await new Promise(r => setTimeout(r, 250));
    if (!await ready()) {
      console.log('启动失败，请查看 ' + join(dataDir, 'server-error.log'));
      process.exitCode = 1;
      return;
    }
  }

  console.log('职向已启动：' + url);
  if (lan) {
    const urls = lanUrls();
    console.log('\n局域网访问地址（同一 Wi-Fi 的手机 / 平板 / 另一台电脑）：');
    for (const u of urls) console.log('  ' + u);
    if (!urls.length) console.log('  未检测到局域网地址，请确认已连接网络。');
    console.log('\n注意：局域网模式是 HTTP 明文，仅建议在可信网络（家里 / 宿舍）使用；');
    console.log('跨网络访问请用 Tailscale 等私有组网，或部署到有 HTTPS 的服务器，不要把端口直接暴露到公网。');
  }
  if (existsSync(join(dataDir, '首次登录.txt'))) {
    console.log('\n首次登录账号与密码见：' + join(dataDir, '首次登录.txt'));
  }
  console.log('关闭这个窗口不会停止服务；需要停止时在任务管理器结束本项目的 node 进程。');

  if (process.platform === 'win32' && !noOpen) {
    spawn('cmd.exe', ['/c', 'start', '', url], {windowsHide: true, detached: true, stdio: 'ignore'}).unref();
  }
}

await main();
