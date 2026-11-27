'use strict';
/* V2 P0-C · AgentExecutor 闭环 + Planner 开关（mock fetch，不联网、不写项目文件） */

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
require(path.join(__dirname, '..', 'core', 'agent-result.js'));
require(path.join(__dirname, '..', 'core', 'agent-executor.js'));
require(path.join(__dirname, '..', 'core', 'planner.js'));

var S = globalThis.Sources;
var T = globalThis.AstroTask;
var G = globalThis.AstroModelGateway;
var EX = globalThis.AstroAgentExecutor;
var P = globalThis.AstroPlanner;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

S.setConfig('deepseek', { key: 'test-key', endpoint: 'https://mock.local/v1/chat/completions', model: 'mock-model' });

var calls = [];
function mockFetch(handler) {
  calls = [];
  global.fetch = function (url, opts) {
    var body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
    calls.push({ url: url, body: body });
    return Promise.resolve(handler(body, calls.length));
  };
}
function jsonRes(obj) {
  return {
    ok: true, status: 200,
    headers: { get: function () { return null; } },
    text: function () { return Promise.resolve(JSON.stringify(obj)); },
    json: function () { return Promise.resolve(obj); }
  };
}
function toolCall(name, args, id) {
  return jsonRes({
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: id || 'call_1', type: 'function', function: { name: name, arguments: JSON.stringify(args || {}) } }] },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  });
}
function textOut(text) {
  return jsonRes({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  });
}

function makeRegistry(opts) {
  opts = opts || {};
  var runCount = 0;
  var specs = {
    'paper.search': {
      id: 'paper.search', version: 't', description: '检索论文',
      argsSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      timeoutMs: 1000,
      run: function (args) {
        runCount += 1;
        if (opts.failTool) return { ok: false, error: { kind: 'tool_error', message: '上游失败', retriable: false } };
        return { items: [{ evidenceId: 'ev1', title: 'M31 distance measurement', sourceId: 'arxiv' }] };
      }
    },
    'evidence.search': {
      id: 'evidence.search', version: 't', description: '检索证据',
      argsSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      timeoutMs: 1000,
      run: function () {
        runCount += 1;
        return { items: [{ evidenceId: 'ev2', title: 'Independent measurement', sourceId: 'openalex' }] };
      }
    },
    'compose.domain': { id: 'compose.domain', version: 't', timeoutMs: 1000, run: function () { return { sections: [] }; } }
  };
  return {
    get: function (id) { return specs[id] || null; },
    list: function () { return Object.keys(specs).map(function (k) { return specs[k]; }); },
    validateArgs: function (id, args) {
      if (id === 'paper.search' && (!args || !args.query)) {
        return { ok: false, errors: [{ path: '$.query', reason: '必填' }] };
      }
      return { ok: true };
    },
    checkDeps: function () { return { ok: true }; },
    runs: function () { return runCount; }
  };
}

function newState() {
  var st = T.create({ id: 't-agent', level: 'L3', question: 'M31 的距离测量是否一致？' });
  st.evidence = [{ evidenceId: 'ev1', title: 'seed', sourceId: 'arxiv', sourceType: 'paper' }];
  return st;
}

function agentStep(tools) {
  return {
    id: 't1', tool: 'agent.research', kind: 'agent', agentId: 'scholar',
    tools: tools || ['paper.search', 'evidence.search'],
    objective: '检索并核验 M31 距离测量', args: { query: 'M31 distance' },
    deps: [], parallel: false, critical: true, optional: false
  };
}

async function main() {
  console.log('\n== P0-C AgentExecutor ==');

  eq('可用模型来源', EX.available(), 'deepseek');

  /* 1. 闭环：模型 → 工具 → 回填 → 最终文本 */
  mockFetch(function (body, n) {
    if (n === 1) return toolCall('paper__search', { query: 'M31 distance' }, 'call_1');
    return textOut('已有两项测量，结论存在轻微差异。');
  });
  var st1 = newState();
  var reg1 = makeRegistry();
  var r1 = await EX.run(agentStep(), { state: st1, registry: reg1, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });
  eq('闭环 status', r1.status, 'completed');
  eq('工具真实执行一次', reg1.runs(), 1);
  eq('工具调用成功', r1.toolCalls[0].status, 'ok');
  ok('工具调用有 executionId', !!r1.toolCalls[0].executionId);
  eq('Agent 证据', r1.evidenceIds, ['ev1']);
  ok('Agent findings 非空', r1.findings.length >= 1);
  eq('promptVersion', r1.provenance.promptVersion, 'scholar.v1');
  eq('第二轮请求含 tool 消息', calls[1].body.messages.some(function (m) { return m.role === 'tool'; }), true);
  eq('第二轮请求含 assistant tool_calls', calls[1].body.messages.some(function (m) { return m.role === 'assistant' && m.tool_calls; }), true);
  eq('系统提示限定表述边界', /不得凭记忆编造/.test(r1.provenance.promptVersion + calls[0].body.messages[0].content), true);

  /* 2. 白名单外工具：拒绝，不执行 */
  mockFetch(function (body, n) {
    if (n === 1) return toolCall('simbad__tap', { query: 'M31' }, 'call_x');
    return textOut('仅基于现有资料作答。');
  });
  var st2 = newState();
  var reg2 = makeRegistry();
  var r2 = await EX.run(agentStep(), { state: st2, registry: reg2, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });
  eq('越权工具被拒绝', r2.toolCalls[0].status, 'rejected');
  eq('越权工具未执行', reg2.runs(), 0);
  eq('越权后仍完成', r2.status, 'completed');

  /* 3. 参数非法：拒绝，不执行 */
  mockFetch(function (body, n) {
    if (n === 1) return toolCall('paper__search', {}, 'call_bad');
    return textOut('参数不足。');
  });
  var st3 = newState();
  var reg3 = makeRegistry();
  var r3 = await EX.run(agentStep(), { state: st3, registry: reg3, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });
  eq('非法参数被拒绝', r3.toolCalls[0].status, 'rejected');
  eq('非法参数未执行', reg3.runs(), 0);

  /* 4. 工具真实失败：不得伪装成功 */
  mockFetch(function (body, n) {
    if (n === 1) return toolCall('paper__search', { query: 'M31' }, 'call_f');
    return textOut('检索失败，无法给出结论。');
  });
  var st4 = newState();
  var reg4 = makeRegistry({ failTool: true });
  var r4 = await EX.run(agentStep(), { state: st4, registry: reg4, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });
  eq('失败工具标记 failed', r4.toolCalls[0].status, 'failed');
  eq('失败工具无证据', r4.evidenceIds, []);
  eq('失败不进入 findings 证据', r4.findings.filter(function (f) { return f.evidenceIds.length; }).length, 0);

  /* 5. 轮次上限 */
  mockFetch(function (body, n) { return toolCall('paper__search', { query: 'M31 ' + n }, 'call_' + n); });
  var st5 = newState();
  st5.budget.limit.llmCalls = 10;
  st5.budget.limit.tokens = 100000;
  var reg5 = makeRegistry();
  var r5 = await EX.run(agentStep(), { state: st5, registry: reg5, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });
  eq('轮次上限 status', r5.status, 'partial');
  ok('轮次上限有说明', r5.limitations.join('|').indexOf('轮次上限') >= 0, r5.limitations.join('|'));
  eq('轮次上限最多 4 轮', calls.length, EX.MAX_TURNS);

  /* 6. 取消：不再发请求 */
  mockFetch(function () { return textOut('nope'); });
  var st6 = newState();
  var ac = new AbortController();
  ac.abort();
  var r6 = await EX.run(agentStep(), { state: st6, registry: makeRegistry(), ctx: {}, cfg: {}, signal: ac.signal, sourceId: 'deepseek' });
  eq('取消 status', r6.status, 'cancelled');
  eq('取消不发请求', calls.length, 0);

  /* 7. Planner 门禁：默认无 Agent，开关开启才出现 */
  var regP = makeRegistry();
  var basePlan = P.plan({
    query: 'M31 距离测量综述', route: { mode: 'research' }, targets: [],
    registry: regP, capabilities: regP.list()
  });
  var agentPlan = P.plan({
    query: 'M31 距离测量综述', route: { mode: 'research' }, targets: [],
    registry: regP, capabilities: regP.list(), agentRuntime: true
  });
  eq('默认计划无 Agent', basePlan.steps.some(function (s) { return s.kind === 'agent'; }), false);
  eq('默认计划步骤数', basePlan.steps.length, 3);
  eq('开启后首步为 Agent', agentPlan.steps[0].kind, 'agent');
  eq('Agent 工具白名单', agentPlan.steps[0].tools, ['paper.search', 'evidence.search']);
  eq('compose 依赖 Agent', agentPlan.steps[1].deps, ['t1']);

  /* 8. 契约：伪造执行会被 P0-B 校验拦截（确认 Executor 走真实校验） */
  eq('AgentResult schemaVersion', r1.schemaVersion, 1);
  eq('AgentResult taskId', r1.taskId, 't-agent');
  eq('AgentResult stepId', r1.stepId, 't1');

  /* 9. W1 fail-closed：无 principal 且未显式允许直调 → 不触碰工具 */
  mockFetch(function () { return toolCall('paper__search', { query: 'M31' }); });
  var st7 = newState();
  var reg7 = makeRegistry();
  var r7 = await EX.run(agentStep(), { state: st7, registry: reg7, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek' });
  ok('W1 无主体不得完成', r7.status !== 'completed', r7.status);
  eq('W1 工具未真实执行', reg7.runs(), 0);
  ok('W1 拒绝而非伪造成功', r7.toolCalls.every(function (c) { return c.status !== 'ok'; }), JSON.stringify(r7.toolCalls));

  console.log('\nP0-C 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
