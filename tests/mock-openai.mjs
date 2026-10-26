// 测试用的假 OpenAI 接口：支持流式/非流式、工具调用、以及规划/执行/复核三个阶段。
// 也支持 Anthropic Messages 与 OpenAI Responses 两种协议，以及 usage 的几种回传方式。
// 目的：不依赖真实 API Key 也能验证整条链路。
import http from 'node:http';

const FINAL = {
  reply: '这是测试回复：已核对来源，给出可执行建议。',
  memory: '测试用户，目标是成都的产品岗。',
  artifact: {title: '', content: ''},
  sources: [{title: '示例来源', url: 'https://example.com/jobs'}],
  visualization: {title: '', unit: '', items: []}
};

// 自动写入用例的固定参数：同键同参数重放、同键不同指纹、缺键三种分支。
const BULK_EVENT = {
  title: '西南财经大学2026届秋季双选会',
  startAt: '2026-11-05T09:00:00+08:00',
  school: '西南财经大学',
  city: '成都',
  kind: '双选会',
  venue: '柳林校区体育馆',
  sourceKey: 'swufe-2026-autumn'
};
const BULK_PROJECT = {eventIndex: 0, company: '中国银行四川省分行', title: '管理培训生', positions: '若干', applyMode: '网申'};
const BULK_SOURCE = {sourceId: 'manual', sourceUrl: 'https://job.swufe.edu.cn/info/1', notes: '浏览器截图读取（非采集器）'};
const bulkArgs = extra => JSON.stringify({events: [BULK_EVENT], projects: [BULK_PROJECT], source: BULK_SOURCE, idempotencyKey: 'idem-http-1', ...extra});

function decide(body, state = {}) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1] || {role: 'user', content: ''};
  const all = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const userText = typeof last.content === 'string' ? last.content : '';
  // #35 外部 Agent 工具：模型像调本地工具一样直接点名 mcp__*。
  const external = (body.tools || []).map(tool => tool?.function?.name || tool?.name)
    .find(name => typeof name === 'string' && name.startsWith('mcp__')) || null;
  if (external && /请调用外部工具/.test(userText)) {
    return {toolCalls: [{id: 'call_external', name: external, args: '{}'}]};
  }
  if (external && /请反复调用外部工具/.test(all)) {
    state.externalRounds = (state.externalRounds || 0) + 1;
    return {toolCalls: [{id: 'call_external_' + state.externalRounds, name: external, args: JSON.stringify({q: state.externalRounds})}]};
  }
  if (body.tools?.length && /研究这个招聘项目/.test(userText)) {
    return {toolCalls: [{id: 'call_career_recruit_projects', name: 'career_recruit_projects', args: '{\"days\":30}'}]};
  }
  if (body.tools?.length && /请调用 career_platform_status/.test(userText)) {
    return {toolCalls: [{id: 'call_career_platform_status', name: 'career_platform_status', args: '{}'}]};
  }
  if (body.tools?.length && /请自动写入招聘活动/.test(userText)) {
    return {toolCalls: [{id: 'call_bulk_write', name: 'career_recruit_bulk_write', args: bulkArgs()}]};
  }
  if (body.tools?.length && /请自动写入另一场招聘活动/.test(userText)) {
    return {toolCalls: [{id: 'call_bulk_write_conflict', name: 'career_recruit_bulk_write', args: bulkArgs({events: [{...BULK_EVENT, title: '西南财经大学2026届秋季双选会（另一场）'}]})}]};
  }
  if (body.tools?.length && /请自动写入缺少幂等键的招聘活动/.test(userText)) {
    return {toolCalls: [{id: 'call_bulk_write_nokey', name: 'career_recruit_bulk_write', args: JSON.stringify({events: [BULK_EVENT]})}]};
  }
  // 敏感写入确认用例：同一句用户话术按序号生成不同幂等键，便于一次测试里拿到多条待确认。
  if (body.tools?.length && last.role === 'user' && /长期画像/.test(userText)) {
    const index = /第二条/.test(userText) ? '2' : /第三条/.test(userText) ? '3' : /第四条/.test(userText) ? '4' : '1';
    const facts = index === '1'
      ? [{key: '手机', value: '13800138000'}, {key: '城市偏好', value: '成都'}]
      : [{key: '期望城市 ' + index, value: '上海'}];
    return {toolCalls: [{id: 'call_profile_write_' + index, name: 'career_profile_write', args: JSON.stringify({facts, idempotencyKey: 'profile-http-' + index})}]};
  }
  // 需要草稿的用例：执行与复核阶段都保留 artifact，模拟任务卡上的草稿区块。
  const base = /生成草稿/.test(all) ? {...FINAL, artifact: {title: '双选会草稿', content: '活动与单位待确认'}} : FINAL;
  if (all.includes('规划阶段')) {
    return {text: JSON.stringify({goal: '回答测试问题', steps: ['理解需求', '给出答复'], needsSearch: false, deliverable: '一段文字'})};
  }
  if (all.includes('复核阶段')) return {text: JSON.stringify(base)};
  return {text: JSON.stringify(base)};
}

function usageValues(usage) {
  if (usage === 'none' || usage === false) return null;
  if (usage && typeof usage === 'object') return {input: Number(usage.input) || 0, output: Number(usage.output) || 0};
  return {input: 11, output: 7};
}

function chatUsage(value) {
  return {prompt_tokens: value.input, completion_tokens: value.output, total_tokens: value.input + value.output};
}

function structuredUsage(value) {
  return {input_tokens: value.input, output_tokens: value.output, total_tokens: value.input + value.output};
}

// usage: 'standard'（OpenAI 风格最后一块/非流式）| 'empty-choices'（Kimi 独立统计块）| 'none'
export async function startMockOpenAI({port = 0, delayMs = 0, usage = 'standard'} = {}) {
  const state = {requests: [], paths: [], failNext: 0, status: 200, usage, failAfterTool: false};
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://mock').pathname;
    const isChat = path.endsWith('/chat/completions');
    const isMessages = path.endsWith('/messages');
    const isResponses = path.endsWith('/responses');
    if (!isChat && !isMessages && !isResponses) { res.writeHead(404); res.end('{}'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 保持空对象 */ }
    state.requests.push(body);
    state.paths.push(path);
    if (state.status && state.status !== 200) { res.writeHead(state.status, {'content-type': 'application/json'}); res.end('{"error":"mock status"}'); return; }
    // 工具已成功执行后的下一次模型请求失败：用来验证副作用门（有工具成功后失败）。
    if (state.failAfterTool && (body.messages || []).at(-1)?.role === 'tool') { res.writeHead(401, {'content-type': 'application/json'}); res.end('{"error":"tool follow-up failed"}'); return; }
    if (state.failNext > 0) { state.failNext--; res.writeHead(429, {'content-type': 'application/json'}); res.end('{"error":"rate limited"}'); return; }
    const answer = decide(body, state);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const value = usageValues(state.usage);

    if (isMessages) {
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant',
        content: [{type: 'text', text: answer.text || ''}],
        ...(value ? {usage: structuredUsage(value)} : {})
      }));
      return;
    }

    if (isResponses) {
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        id: 'resp_mock', object: 'response',
        output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: answer.text || ''}]}],
        ...(value ? {usage: structuredUsage(value)} : {})
      }));
      return;
    }

    if (body.stream) {
      res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'});
      const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (answer.toolCalls) {
        send({choices: [{delta: {tool_calls: answer.toolCalls.map((t, i) => ({index: i, id: t.id, type: 'function', function: {name: t.name, arguments: t.args}}))}}]});
      } else {
        for (const piece of answer.text.match(/[\s\S]{1,24}/g) || []) send({choices: [{delta: {content: piece}}]});
      }
      if (value && state.usage === 'empty-choices') {
        // Kimi：choices 为空的独立统计块，位于 [DONE] 之前。
        send({choices: [], usage: chatUsage(value)});
      } else {
        send({choices: [{delta: {}, finish_reason: 'stop'}], ...(value ? {usage: chatUsage(value)} : {})});
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    if (answer.toolCalls) {
      res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: '', tool_calls: answer.toolCalls.map(t => ({id: t.id, type: 'function', function: {name: t.name, arguments: t.args}}))}}], ...(value ? {usage: chatUsage(value)} : {})}));
    } else {
      res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: answer.text}}], ...(value ? {usage: chatUsage(value)} : {})}));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  return {url: base, state, close: () => new Promise(resolve => server.close(resolve))};
}


// 直接运行时作为独立服务，方便手工联调：node tests/mock-openai.mjs 18080
if (process.argv[1] && /mock-openai\.mjs$/.test(process.argv[1])) {
  const port = Number(process.argv[2] || 18080);
  const mock = await startMockOpenAI({port});
  console.log('mock OpenAI listening at ' + mock.url);
}
