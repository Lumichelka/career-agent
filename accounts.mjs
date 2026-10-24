import {randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
export class Accounts{
 constructor(dataDir){this.dir=dataDir;this.users=[];this.sessions=new Map();this.attempts=new Map();this.queue=Promise.resolve();}
 async init(){await mkdir(this.dir,{recursive:true});try{this.users=JSON.parse(await readFile(join(this.dir,'accounts.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
 async register(name,password){const work=this.queue.then(async()=>{
  if(typeof name!=='string'||! /^[a-zA-Z0-9_-]{3,32}$/.test(name))throw Error('账号须为3至32位字母、数字、下划线或连字符');
  if(typeof password!=='string'||password.length<10||password.length>128)throw Error('密码须为10至128位');
  if(this.users.some(u=>u.name.toLowerCase()===name.toLowerCase()))throw Error('账号已存在');
  if(this.users.length>=100)throw Error('测试账号数量已达上限');
  const salt=randomBytes(16).toString('hex'),u={id:randomUUID(),name,salt,hash:scryptSync(password,salt,64).toString('hex')};
  this.users.push(u);try{await writeFile(join(this.dir,'accounts.json'),JSON.stringify(this.users),'utf8')}catch(e){this.users.pop();throw e}return u;
 });this.queue=work.catch(()=>{});return work;}
 login(name,password){const key=String(name).toLowerCase(),now=Date.now(),a=this.attempts.get(key);if(a&&a.count>=5&&now-a.at<60000)throw Error('尝试过于频繁，请一分钟后重试');
  const u=this.users.find(u=>u.name.toLowerCase()===key),hash=scryptSync(String(password).slice(0,128),u?.salt||'invalid',64);
  if(!u||!timingSafeEqual(hash,Buffer.from(u.hash,'hex'))){this.attempts.set(key,{count:(a&&now-a.at<60000?a.count:0)+1,at:now});throw Error('账号或密码错误')}
  this.attempts.delete(key);const token=randomBytes(32).toString('hex');this.sessions.set(token,{id:u.id,expires:now+12*3600000});return {token,user:{id:u.id,name:u.name}};
 }
 authenticate(cookie=''){const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('career_auth='))?.slice(12);const s=this.sessions.get(token);if(!s||s.expires<Date.now()){this.sessions.delete(token);return null}return this.users.find(u=>u.id===s.id);}
 logout(cookie=''){const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('career_auth='))?.slice(12);this.sessions.delete(token);}
}
