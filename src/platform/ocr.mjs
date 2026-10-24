// 截图 OCR 兜底：Windows 自带 Windows.Media.Ocr，失败时返回原因，不伪造文字。
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/ocr.ps1', import.meta.url));

export async function ocrImage(file, {timeout = 25000} = {}) {
  if (process.platform !== 'win32') return {ok: false, reason: '当前系统没有可用的本地 OCR'};
  const absolute = resolve(file);
  if (!existsSync(absolute)) return {ok: false, reason: '截图文件不存在'};
  if (!existsSync(SCRIPT)) return {ok: false, reason: '缺少 scripts/ocr.ps1'};
  return new Promise(resolvePromise => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, absolute], {
      timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
        .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
        .replace(/\s+([，。；：、！？])/g, '$1');
      if (text.length >= 2) return resolvePromise({ok: true, text});
      resolvePromise({ok: false, reason: (stderr || error?.message || 'OCR 未识别到文字').trim().slice(0, 300)});
    });
  });
}
