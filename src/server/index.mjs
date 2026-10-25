// 统一入口：读环境、准备数据目录、启动 HTTP 服务。
// 服务本体在 createApp（./app.mjs），这里只负责进程级的事：环境变量、日志与监听失败退出。
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import os from 'node:os';
import {prepareDataDir} from '../config/paths.mjs';
import {createApp} from './app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const host = process.env.CAREER_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4189);
const dataDir = await prepareDataDir({root, log: message => console.log(message)});
const app = await createApp({root, dataDir, host, port});
const lan = host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => 'http://' + n.address + ':' + app.port) : [];
console.log('职向智能体：http://127.0.0.1:' + app.port);
if (lan.length) console.log('局域网访问（同一 Wi-Fi 的其它设备）：' + lan.join(' '));
console.log('只保存本机数据；不会收集招聘平台密码。首次进入请用 ' + join(app.dataDir, '首次登录.txt') + ' 里的账号登录。');
