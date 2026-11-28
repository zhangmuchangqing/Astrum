'use strict';
/* V2 阶段 H · Agent 边界：部分成果 / 空成果 / 预算 / 能力矩阵（离线） */

var path = require('path');
var CORE = path.join(__dirname, '..', 'core');
var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
};
[
  'sources.js', 'task.js', 'model-gateway.js', 'agent-result.js',
  'agent-executor.js', 'evidence.js', 'claims.js', 'reducer.js',
  'report.js', 'compose-adapter.js', 'planner.js', 'orchestrator.js'
].forEach(function (f) { require(path.join(CORE, f)); });

var T = globalThis.AstroTask;
var AR = globalThis.AstroAgentResult;
var EX = globalThis.AstroAgentExecutor;
var O = globalThis.AstroOrchestrator;
var CA = globalThis.AstroComposeAdapter;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function budget(llm) {
  return {
    limit: { llmCalls: llm, toolCalls: 20, replans: 2, tokens: 100000, ms: 60000 },
    used: { llmCalls: 0, toolCalls: 0, replans: 0, tokens: 0, ms: 0 }
  };
}
var ev1 = {
  evidenceId: 'ev-edge-1', sourceType: 'paper', sourceId: 'arxiv',
  title: 'Edge evidence', uri: 'https://arxiv.org/abs/2401.00001',
  snippet: 'H0 = 70', retrievedAt: '2026-11-27T00:00:00Z', content: {}
};
function makeState(withEv, llm) {
  return {
    id: 'task-h', phase: 'EXECUTE', question: 'q', events: [],
    budget: budget(llm == null ? 10 : llm),
    evidence: withEv ? [ev1] : [], agentResults: [],
    steps: [T.makeStep({ id: 't1', tool: 'agent.research', kind: 'agent', status: 'pending', critical: true })]
  };
}
var planStep = { id: 't1', tool: 'agent.research', kind: 'agent', agentId: 'scholar', critical: true, args: { query: 'q' } };
var opts = { registry: null, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek' };

/* 1. partial：部分成果仍为 ok，且证据可挂载 */
var seq = Promise.resolve();
seq = seq.then(function () {
  var st = makeState(true);
  EX.run = function (ps, o) {
    return Promise.resolve(AR.create({
      taskId: o.state.id, stepId: ps.id, agentId: 'scholar', status: 'partial',
      objective: '检索', startedAt: Date.now() - 20, completedAt: Date.now(),
      toolCalls: [{ id: 'c1', name: 'paper.search', args: {}, status: 'ok', executionId: 'e1', evidenceIds: ['ev-edge-1'] }],
      findings: [{ text: 'partial finding', level: 'inference', evidenceIds: ['ev-edge-1'] }],
      evidenceIds: ['ev-edge-1'],
      limitations: ['仅取得部分证据'],
      provenance: { provider: 'deepseek', promptVersion: 'scholar.v1', tools: ['paper.search'] }
    }));
  };
  return O.Runner.executeOne(planStep, st, opts).then(function () {
    eq('partial 步骤判定成功', st.steps[0].status, 'ok');
    eq('partial 保留在 agentResults', st.agentResults[0].status, 'partial');
    ok('partial 证据挂到步骤结果', !!(st.steps[0].result.items && st.steps[0].result.items.length === 1));
  });
});

/* 2. 空成果：不伪造 items；compose 不产生 research */
seq = seq.then(function () {
  var st = makeState(false);
  EX.run = function (ps, o) {
    return Promise.resolve(AR.create({
      taskId: o.state.id, stepId: ps.id, agentId: 'scholar', status: 'completed',
      objective: '检索', startedAt: Date.now() - 10, completedAt: Date.now(),
      toolCalls: [], findings: [], evidenceIds: [],
      limitations: ['未获得可用证据'],
      provenance: { provider: 'deepseek', promptVersion: 'scholar.v1', tools: [] }
    }));
  };
  return O.Runner.executeOne(planStep, st, opts).then(function () {
    ok('空成果不挂 items', !st.steps[0].result.items);
    eq('agentResults 仍记录空成果', st.agentResults.length, 1);
    var adapter = CA.create({
      agentCore: {
        buildAnswer: function () { return { query: 'q', sections: [], meta: {} }; },
        defaultConfig: function () { return {}; }
      }
    });
    var cr = adapter.compose({ query: 'q', intent: 'cosmos', from: ['t1'] }, {}, {},
      { t1: st.steps[0].result });
    ok('compose 仍返回但无 research', !!cr && !cr.answer.research);
  });
});

/* 3. 预算耗尽：步骤 skipped，不调用执行器 */
seq = seq.then(function () {
  var st = makeState(false, 0);
  var called = false;
  EX.run = function () { called = true; return Promise.resolve(null); };
  return O.Runner.executeOne(planStep, st, opts).then(function (out) {
    eq('预算耗尽跳过', st.steps[0].status, 'skipped');
    eq('预算错误类型', st.steps[0].error && st.steps[0].error.kind, 'budget');
    eq('预算失败原因', out.reason, 'budget');
    ok('预算耗尽不调用执行器', !called);
    eq('预算耗尽无 agentResults', st.agentResults.length, 0);
  });
});

/* 4. 能力矩阵：未注册 agent 一律不可执行 */
seq = seq.then(function () {
  eq('未知 Agent 不可执行', EX.capability('ghost').executable, false);
  eq('muse 不可独立执行', EX.capability('muse').executable, false);
  ok('不可执行有原因', !!EX.capability('muse').reason);
});

seq.then(function () {
  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  if (failed) { console.log('失败项：' + failures.join('、')); process.exit(1); }
}).catch(function (e) {
  console.log('  FAIL 未捕获异常 :: ' + (e && e.stack || e));
  process.exit(1);
});
