// Keep validation and retry decisions outside model-generated text.
export function validateToolArguments(name,args){
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('工具参数必须是对象');
  const fields={career_platform_status:[],career_platform_read:['platform'],career_platform_search:['platform','query'],career_public_search:['query'],career_company_research:['company','city'],career_recruit_events:['days','school','kind']}[name];
  if(!fields)throw new Error('工具未开放');
  if(Object.keys(args).some(k=>!fields.includes(k)))throw new Error('工具包含未声明参数');
  if(fields.includes('platform')&&!['boss','xiaohongshu'].includes(args.platform))throw new Error('平台参数无效');
  if(fields.includes('query')&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>120))throw new Error('搜索词须为1至120个字符');
  if(fields.includes('company')&&(typeof args.company!=='string'||!args.company.trim()||args.company.length>60))throw new Error('公司名须为1至60个字符');
  if(fields.includes('city')&&args.city!==undefined&&(typeof args.city!=='string'||args.city.length>20))throw new Error('城市名过长');
  if(fields.includes('days')&&args.days!==undefined&&(!Number.isFinite(Number(args.days))||Number(args.days)<1||Number(args.days)>90))throw new Error('天数需在1到90之间');
  if(fields.includes('school')&&args.school!==undefined&&(typeof args.school!=='string'||args.school.length>30))throw new Error('学校名过长');
  if(fields.includes('kind')&&args.kind!==undefined&&!['宣讲会','双选会','就业指导','招聘信息','其他'].includes(args.kind))throw new Error('活动类型无效');
  return Object.fromEntries(fields.filter(k=>args[k]!==undefined).map(k=>[k,(k==='query'||k==='company'||k==='city'||k==='school')?String(args[k]).trim():args[k]]));
}
export function createToolPolicy(){
  const seen=new Map();
  return async function execute(name,rawArgs,call){
    let args;try{args=validateToolArguments(name,rawArgs)}catch(e){return {status:'error',code:'INVALID_ARGUMENTS',message:e.message,recovery:'根据工具声明修正参数后重试。'}}
    const key=JSON.stringify([name,args]);
    if(seen.has(key))return {status:'blocked',code:'DUPLICATE_CALL',message:'本次任务已执行过相同请求，未再次访问平台。',previousStatus:seen.get(key),recovery:'使用先前结果；无结果时更换关键词，登录或网络问题则说明所需操作，不要原样重试。'};
    let result;try{result=await call(args)}catch(e){result={status:'error',code:'TOOL_FAILED',message:e.message,recovery:'检查错误原因，换用可用来源或说明尚未完成的部分。'}}
    seen.set(key,result?.status||'returned');return result;
  };
}
