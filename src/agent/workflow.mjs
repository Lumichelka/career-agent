export function parsePlan(raw){
  const p=JSON.parse(raw);
  if(typeof p.goal!=='string'||!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>5||p.steps.some(s=>typeof s!=='string'||!s.trim())||typeof p.needsSearch!=='boolean'||typeof p.deliverable!=='string')throw new Error('行动计划格式无效，请重试。');
  return p;
}
export function checkDelivery(result,{needsSearch=false,trace=[]}={}){
  const issues=[];
  if(!result.reply.trim())issues.push('没有回答当前问题');
  if(result.artifact.content&&!result.artifact.title.trim())issues.push('文稿缺少标题');
  if(needsSearch&&!trace.some(t=>['web_search','web_search_call','mcp_tool_call'].includes(t.type)))issues.push('未观察到检索工具调用，不能把输出当作实时检索结果');
  if(needsSearch&&!result.sources.length)issues.push('未交付可引用来源，本次联网结果不完整');
  const seen=new Set();result.sources=result.sources.filter(s=>{if(seen.has(s.url))return false;seen.add(s.url);return true;});
  return {status:issues.length?'limited':'checked',issues,notice:'检查回答、文稿和工具执行记录；不代表独立核实了每一项招聘事实。'};
}
