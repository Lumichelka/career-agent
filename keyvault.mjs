// API Key 的本地持久化：AES-256-GCM 加密后写入该账号的 .data。
// 之前 Key 只存在内存里，重启就丢，用户会误以为"接口坏了"。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {join} from 'node:path';

const AAD = 'career-agent-vault-v1';

export class KeyVault {
  constructor(dir) {
    this.dir = dir;
    this.keyFile = join(dir, 'vault.key');
    this.file = join(dir, 'secrets.enc.json');
    this.key = null;
    this.cache = new Map();
  }

  async init() {
    await mkdir(this.dir, {recursive: true});
    try {
      const hex = (await readFile(this.keyFile, 'utf8')).trim();
      const key = Buffer.from(hex, 'hex');
      if (key.length !== 32) throw new Error('vault key 长度异常');
      this.key = key;
    } catch {
      this.key = randomBytes(32);
      await writeFile(this.keyFile, this.key.toString('hex'), {encoding: 'utf8', mode: 0o600});
    }
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      for (const [name, box] of Object.entries(raw)) {
        try { this.cache.set(name, this.#open(box)); } catch { /* 单条损坏不影响其它 */ }
      }
    } catch { /* 首次运行没有文件 */ }
    return this;
  }

  #open(box) {
    const iv = Buffer.from(box.iv, 'base64');
    const tag = Buffer.from(box.tag, 'base64');
    const data = Buffer.from(box.data, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from(AAD));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }

  #seal(plain) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(AAD));
    const data = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
    return {iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64')};
  }

  async #flush() {
    const out = {};
    for (const [name, value] of this.cache) out[name] = this.#seal(value);
    await writeFile(this.file, JSON.stringify(out, null, 2), {encoding: 'utf8', mode: 0o600});
  }

  get(name) { return this.cache.get(name) || ''; }
  has(name) { return this.cache.has(name) && !!this.cache.get(name); }

  async set(name, value) {
    if (!value) { await this.delete(name); return; }
    this.cache.set(name, String(value));
    await this.#flush();
  }

  async delete(name) {
    if (!this.cache.delete(name)) return;
    await this.#flush();
  }

  labels() { return [...this.cache.keys()]; }
}
