'use strict';
/* V2 P0-A · ModelGateway 离线测试（mock fetch，不联网、不写项目文件） */

var path = require('path');

var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
};

require(path.join(__dirname, '..', 'core', 'sources.js'));
require(path.join(__dirname, '..', 'core', 'task.js'));
require(path.join(__dirname, '..', 'core', 'model-gateway.js'));

var S = globalThis.Sources;
var T = globalThis.AstroTask;
var G = globalThis.AstroModelGateway;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function jsonRes(status, obj, headers) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function (h) { return (headers || {})[String(h).toLowerCase()] || null; } },
    text: function () { return Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    json: function () { return Promise.resolve(obj); }
  };
}

var calls = [];
function mockFetch(handler) {
  calls = [];
  global.fetch = function (url, opts) {
    var body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = opts && opts.body; }
    var rec = { url: url, opts: opts, body: body };
    calls.push(rec);
    return Promise.resolve(handler(rec, calls.length));
  };
  return calls;
}

S.setConfig('deepseek', { key: 'test-key', endpoint: 'https://mock.local/v1/chat/completions', model: 'mock-openai' });
S.setConfig('anthropic', { key: 'test-key', endpoint: 'https://mock.local/v1/messages', model: 'mock-claude' });
S.setConfig('gemini', { key: 'test-key', endpoint: 'https://mock.local/v1beta', model: 'mock-gemini' });

function openaiText(text, usage) {
  return {
    id: 'req-1',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: usage || { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  };
}

async function main() {
  console.log('\n== P0-A ModelGateway ==');

  /* 1. OpenAI 工具请求构造 */
  mockFetch(function () { return jsonRes(200, openaiText('答案')); });
  var r1 = await G.generate({
    sourceId: 'deepseek',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: '问题' }],
    tools: [{ name: 'paper__search', description: '检索论文', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }]
  });
  eq('openai 状态 completed', r1.status, 'completed');
  eq('openai 文本', r1.text, '答案');
  eq('openai 工具类型', calls[0].body.tools[0].type, 'function');
  eq('openai 工具名', calls[0].body.tools[0].function.name, 'paper__search');
  eq('openai tool_choice', calls[0].body.tool_choice, 'auto');
  eq('openai system 消息', calls[0].body.messages[0].role, 'system');
  eq('usage promptTokens', r1.usage.promptTokens, 11);
  eq('usage totalTokens', r1.usage.totalTokens, 18);

  /* 2. OpenAI tool_calls 解析 */
  mockFetch(function () {
    return jsonRes(200, {
      id: 'req-2',
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'paper__search', arguments: '{"q":"M31"}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
    });
  });
  var r2 = await G.generate({
    sourceId: 'deepseek', messages: [{ role: 'user', content: '找 M31 论文' }],
    tools: [{ name: 'paper__search', parameters: { type: 'object', properties: {} } }]
  });
  eq('tool_calls 数量', r2.toolCalls.length, 1);
  eq('tool_calls 名称', r2.toolCalls[0].name, 'paper__search');
  eq('tool_calls 参数解析', r2.toolCalls[0].arguments, { q: 'M31' });
  eq('tool_calls finishReason', r2.finishReason, 'tool_calls');

  /* 3. 非法 JSON 参数必须失败 */
  mockFetch(function () {
    return jsonRes(200, {
      choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{bad json' } }] }, finish_reason: 'tool_calls' }]
    });
  });
  var r3 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'x' }] });
  eq('非法参数 status', r3.status, 'failed');
  eq('非法参数 code', r3.error.code, 'TOOL_CALL_PARSE_ERROR');

  /* 4. 空响应必须失败，不能当成功 */
  mockFetch(function () { return jsonRes(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }); });
  var r4 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }] });
  eq('空响应 status', r4.status, 'failed');
  eq('空响应 code', r4.error.code, 'INVALID_RESPONSE');

  /* 5. 401 不重试 */
  mockFetch(function () { return jsonRes(401, 'invalid key'); });
  var r5 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }], maxRetries: 2 });
  eq('401 code', r5.error.code, 'AUTH_ERROR');
  eq('401 不重试', calls.length, 1);

  /* 6. 429 重试后成功 */
  G.resetStats();
  mockFetch(function (rec, n) {
    if (n === 1) return jsonRes(429, 'rate limited');
    return jsonRes(200, openaiText('ok'));
  });
  var r6 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }], maxRetries: 1 });
  eq('429 重试后成功', r6.status, 'completed');
  eq('429 请求次数', calls.length, 2);
  eq('429 重试计数', G.stats().retries, 1);

  /* 7. 取消：不发请求 */
  mockFetch(function () { return jsonRes(200, openaiText('nope')); });
  var ac = new AbortController();
  ac.abort();
  var r7 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }], signal: ac.signal });
  eq('取消 status', r7.status, 'aborted');
  eq('取消不发请求', calls.length, 0);

  /* 8. 超时 */
  mockFetch(function (rec) {
    return new Promise(function (resolve, reject) {
      if (rec.opts && rec.opts.signal) {
        rec.opts.signal.addEventListener('abort', function () {
          var e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  });
  var r8 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'timeout-case' }], timeoutMs: 40, maxRetries: 0 });
  eq('超时 status', r8.status, 'failed');
  eq('超时 code', r8.error.code, 'TIMEOUT');

  /* 9. Anthropic 协议 */
  mockFetch(function () {
    return jsonRes(200, {
      id: 'msg-1',
      content: [
        { type: 'text', text: '你好' },
        { type: 'tool_use', id: 'tu1', name: 'evidence__search', input: { q: 'x' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 4 }
    });
  });
  var r9 = await G.generate({
    sourceId: 'anthropic',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U' }],
    tools: [{ name: 'evidence__search', description: 'd', parameters: { type: 'object', properties: {} } }]
  });
  ok('anthropic system 为块数组', Array.isArray(calls[0].body.system) && calls[0].body.system[0].text === 'SYS');
  eq('anthropic input_schema 存在', !!calls[0].body.tools[0].input_schema, true);
  eq('anthropic 工具 id', r9.toolCalls[0].id, 'tu1');
  eq('anthropic 文本', r9.text, '你好');
  eq('anthropic usage', r9.usage.totalTokens, 12);

  /* 10. Gemini 协议 */
  mockFetch(function () {
    return jsonRes(200, {
      candidates: [{
        content: { parts: [{ text: 'g' }, { functionCall: { name: 'simbad__tap', args: { target: 'M31' } } }] },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
    });
  });
  var r10 = await G.generate({
    sourceId: 'gemini',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U' }],
    tools: [{ name: 'simbad__tap', parameters: { type: 'object', properties: {} } }]
  });
  eq('gemini 函数声明', calls[0].body.tools[0].functionDeclarations[0].name, 'simbad__tap');
  eq('gemini 调用名', r10.toolCalls[0].name, 'simbad__tap');
  eq('gemini 参数', r10.toolCalls[0].arguments, { target: 'M31' });
  eq('gemini usage', r10.usage.totalTokens, 7);

  /* 11. 能力声明：明确不支持流式工具调用 */
  var cap = G.capabilities('deepseek');
  eq('tools 支持', cap.tools, true);
  eq('streamingTools 明确为 false', cap.streamingTools, false);
  eq('未知来源 exists=false', G.capabilities('not-exist').exists, false);

  /* 12. 预算拒绝 */
  mockFetch(function () { return jsonRes(200, openaiText('x')); });
  var st = T.create({ id: 't-budget', level: 2 });
  st.budget.used.llmCalls = st.budget.limit.llmCalls;
  var r12 = await G.generate({ sourceId: 'deepseek', messages: [{ role: 'user', content: 'x' }], state: st });
  eq('预算耗尽 code', r12.error.code, 'BUDGET_EXCEEDED');
  eq('预算耗尽不发请求', calls.length, 0);

  console.log('\nP0-A 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
