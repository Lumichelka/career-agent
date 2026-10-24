import {chromium} from 'playwright';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
export const PLATFORMS={boss:{name:'BOSS直聘',home:'https://www.zhipin.com/',domain:'zhipin.com'},xiaohongshu:{name:'小红书',home:'https://www.xiaohongshu.com/explore',domain:'xiaohongshu.com'}};
export function validatePlatform(id){if(!Object.hasOwn(PLATFORMS,id))throw new Error('不支持的平台');return PLATFORMS[id];}
export function allowedPlatformUrl(id,raw){const p=validatePlatform(id);try{const u=new URL(raw);return u.protocol==='https:'&&(u.hostname===p.domain||u.hostname.endsWith('.'+p.domain))&&!u.username&&!u.password}catch{return false}}
export function searchUrl(id,query){validatePlatform(id);if(typeof query!=='string'||!query.trim()||query.length>120)throw new Error('搜索词需为1至120字，不含个人联系方式');if(/\b1[3-9]\d{9}\b|[^\s]+@[^\s]+\.[^\s]+/.test(query))throw new Error('不要把电话、邮箱放入平台搜索词');return id==='boss'?'https://www.zhipin.com/web/geek/job?query='+encodeURIComponent(query):'https://www.xiaohongshu.com/search_result?keyword='+encodeURIComponent(query)+'&source=web_explore_feed';}
export function readablePath(id,raw){if(!allowedPlatformUrl(id,raw))return false;const u=new URL(raw);return id==='boss'?u.pathname==='/'||u.pathname.startsWith('/web/geek/job')||u.pathname.startsWith('/job_detail/'):u.pathname==='/explore'||u.pathname.startsWith('/explore/')||u.pathname==='/search_result'||u.pathname.startsWith('/discovery/item/');}
export class PlatformBrowser{
  constructor(root){this.root=root;this.states=new Map();this.locks=new Map();}
  async serial(id,fn){const previous=this.locks.get(id)||Promise.resolve();const result=previous.catch(()=>{}).then(fn);this.locks.set(id,result.catch(()=>{}));return result;}
  async open(id){return this.serial(id,async()=>{
    const p=validatePlatform(id);let state=this.states.get(id);if(state&&!state.page.isClosed()){await state.page.bringToFront();return this.status(id)}
    const profile=join(this.root,'.data','platform-profiles',id);await mkdir(profile,{recursive:true});
    const context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:false,chromiumSandbox:true,viewport:{width:1180,height:820},acceptDownloads:false});
    const page=context.pages()[0]||await context.newPage();state={context,page,error:'',openedAt:new Date().toISOString()};this.states.set(id,state);
    context.on('close',()=>{if(this.states.get(id)===state)this.states.delete(id)});
    await context.route('**/*',async route=>{const req=route.request();if(req.isNavigationRequest()&&req.frame()===req.frame().page().mainFrame()&&!allowedPlatformUrl(id,req.url())&&req.url()!=='about:blank')return route.abort();return route.continue()});
    context.on('page',popped=>{popped.on('domcontentloaded',()=>{if(readablePath(id,popped.url()))state.page=popped})});
    try{await page.goto(p.home,{waitUntil:'domcontentloaded',timeout:30000})}catch(e){state.error='页面载入未完成，请在打开的浏览器中检查网络或登录提示。'}
    return this.status(id);
  });}
  async status(id){const p=validatePlatform(id),s=this.states.get(id);if(!s||s.page.isClosed())return {id,name:p.name,state:'closed',message:'未打开平台浏览器'};return {id,name:p.name,state:'opened',message:s.error||'浏览器已打开；请在官方页面完成登录，再检查可读内容。',url:allowedPlatformUrl(id,s.page.url())?s.page.url():p.home};}
  async statuses(){return Promise.all(Object.keys(PLATFORMS).map(id=>this.status(id)))}
  async read(id){return this.serial(id,()=>this.readPage(id))}
  async readPage(id){validatePlatform(id);const s=this.states.get(id);if(!s||s.page.isClosed())return {platform:id,status:'needs_connection',message:'请先在智能体的“连接平台”里打开此平台并由本人登录。',sources:[]};
    const url=s.page.url();if(!readablePath(id,url))return {platform:id,status:'needs_user',message:'当前不是可读取的岗位、笔记或搜索页面。请本人完成登录/验证，再打开搜索结果或详情。',sources:[]};
    const hasPassword=await s.page.locator('input[type="password"]:visible').count();const hasCode=await s.page.locator('input[autocomplete="one-time-code"]:visible').count();
    if(hasPassword||hasCode)return {platform:id,status:'needs_login',message:'当前正在登录或验证，请本人完成；智能体不会读取验证码或密码。',sources:[]};
    const data=await s.page.evaluate(()=>({title:document.title,text:document.body.innerText.slice(0,18000),links:Array.from(document.querySelectorAll('a[href]')).map(a=>({title:a.innerText.trim().slice(0,150),url:a.href})).filter(a=>a.title).slice(0,300)}));
    if(/安全验证|访问异常|滑块验证|请完成验证|访问受限/.test(data.text))return {platform:id,status:'needs_verification',message:'平台要求本人完成验证或限制了访问，已停止读取。',sources:[]};
    const sources=data.links.filter(a=>allowedPlatformUrl(id,a.url)&&(id==='boss'?new URL(a.url).pathname.startsWith('/job_detail/'): /\/(explore|discovery\/item)\//.test(new URL(a.url).pathname))).slice(0,25);
    return {platform:id,status:sources.length||/\/job_detail\/|\/explore\/.+|\/discovery\/item\//.test(url)?'readable':'unconfirmed',message:'以下为浏览器实际显示的文字，页面可读不等于登录已确认；未加载内容不能补造。',url,title:data.title,text:data.text,sources,readAt:new Date().toISOString()};
  }
  async search(id,query){return this.serial(id,async()=>{const url=searchUrl(id,query),s=this.states.get(id);if(!s||s.page.isClosed())return {platform:id,status:'needs_connection',message:'请先连接平台并本人登录。',sources:[]};const start=Date.now();if(s.lastSearch&&start-s.lastSearch<5000)throw new Error('搜索过快，请稍候再试');s.lastSearch=start;
    try{await s.page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await s.page.locator('a[href*="job_detail"],a[href*="/explore/"],a[href*="/discovery/item/"]').first().waitFor({state:'visible',timeout:7000}).catch(()=>{});}catch{return {platform:id,status:'load_failed',message:'平台搜索页面未载入完成，请在平台浏览器里检查。',sources:[]}}
    return this.readPage(id);
  });}
  async close(id){validatePlatform(id);return this.serial(id,async()=>{await this.states.get(id)?.context.close();this.states.delete(id);return this.status(id)})}
}
