// 测试用的假 OpenAI 接口：支持流式/非流式、工具调用、以及规划/执行/复核三个阶段。
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

function decide(body) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1] || {role: 'user', content: ''};
  const all = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const userText = typeof last.content === 'string' ? last.content : '';
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
  // 需要草稿的用例：执行与复核阶段都保留 artifact，模拟任务卡上的草稿区块。
  const base = /生成草稿/.test(all) ? {...FINAL, artifact: {title: '双选会草稿', content: '活动与单位待确认'}} : FINAL;
  if (all.includes('规划阶段')) {
    return {text: JSON.stringify({goal: '回答测试问题', steps: ['理解需求', '给出答复'], needsSearch: false, deliverable: '一段文字'})};
  }
  if (all.includes('复核阶段')) return {text: JSON.stringify(base)};
  return {text: JSON.stringify(base)};
}

export async function startMockOpenAI({port = 0, delayMs = 0} = {}) {  const state = {requests: [], failNext: 0, status: 200};
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 保持空对象 */ }
    state.requests.push(body);
    if (state.status && state.status !== 200) { res.writeHead(state.status, {'content-type': 'application/json'}); res.end('{"error":"mock status"}'); return; }
    if (state.failNext > 0) { state.failNext--; res.writeHead(429, {'content-type': 'application/json'}); res.end('{"error":"rate limited"}'); return; }
    const answer = decide(body);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

    if (body.stream) {
      res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'});
      const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (answer.toolCalls) {
        send({choices: [{delta: {tool_calls: answer.toolCalls.map((t, i) => ({index: i, id: t.id, type: 'function', function: {name: t.name, arguments: t.args}}))}}]});
      } else {
        for (const piece of answer.text.match(/[\s\S]{1,24}/g) || []) send({choices: [{delta: {content: piece}}]});
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    if (answer.toolCalls) {
      res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: '', tool_calls: answer.toolCalls.map(t => ({id: t.id, type: 'function', function: {name: t.name, arguments: t.args}}))}}]}));
    } else {
      res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: answer.text}}]}));
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
