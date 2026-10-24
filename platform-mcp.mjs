import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const base=process.env.CAREER_BRIDGE_URL,token=process.env.CAREER_BRIDGE_TOKEN;
if(!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)||!token)throw new Error('缺少本机平台桥接配置');
const server=new Server({name:'career-platform-reader',version:'1.0.0'},{capabilities:{tools:{}}});
const platform={type:'string',enum:['boss','xiaohongshu']};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 {name:'career_platform_status',description:'检查用户在求职智能体里已打开的平台浏览器。不能把opened当作已登录。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
 {name:'career_platform_search',description:'在用户本人打开的平台浏览器中搜索BOSS求职岗位或小红书笔记，返回当前可见文字和来源。未连接/登录/验证时如实返回，不代填登录，不发消息不投递。搜索词不得含电话邮箱完整简历。',inputSchema:{type:'object',properties:{platform,query:{type:'string',minLength:1,maxLength:120}},required:['platform','query'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},
 {name:'career_platform_read',description:'读取用户当前打开的岗位/笔记/搜索页可见内容。可让用户先打开某条详情再读取；不读取私信、账号设置、简历管理或登录表单。',inputSchema:{type:'object',properties:{platform},required:['platform'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}
]}));
server.setRequestHandler(CallToolRequestSchema,async r=>{const action={career_platform_status:'status',career_platform_search:'search',career_platform_read:'read'}[r.params.name];if(!action)throw new Error('未知工具');try{const response=await fetch(base+'/api/platform/'+action,{method:'POST',headers:{'Content-Type':'application/json','x-career-token':token},body:JSON.stringify({...r.params.arguments,taskId:process.env.CAREER_TASK_ID||''}),signal:AbortSignal.timeout(410000)});const value=await response.json();return {content:[{type:'text',text:JSON.stringify(value)}],isError:!response.ok}}catch(e){return {content:[{type:'text',text:'平台工具连接失败：'+e.message}],isError:true}}});
await server.connect(new StdioServerTransport());
