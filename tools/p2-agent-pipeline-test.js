'use strict';
/* V2 阶段 B · Agent → Compose 闭环与失败留存（离线，不发网络请求）
 *
 * 覆盖：
 *   1) T-F + agentRuntime 生成 agent + compose.domain；
 *   2) Agent 成功：证据挂到步骤结果，compose 可消费；
 *   3) Agent 抛异常：agentResults 仍保留失败成果；
 *   4) compose 真正消费 Agent findings（reducer.byAgent）。
 */

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
var P = globalThis.AstroPlanner;
var O = globalThis.AstroOrchestrator;
var CA = globalThis.AstroComposeAdapter;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function budget() {
  return {
    limit: { llmCalls: 10, toolCalls: 20, replans: 2, tokens: 100000, ms: 60000 },
    used: { llmCalls: 0, toolCalls: 0, replans: 0, tokens: 0, ms: 0 }
  };
}

/* ---------- 1. Planner：T-F 必须带 compose ---------- */
var route = {
  mode: 'research', complexity: 4, level: 'L4', legacy: false,
  targets: [], branches: [{ intent: 'cosmos', topic: 'research' }],
  signals: { mentions: 0, compare: true, why: false, research: true, targetParam: false }
};
var planIn = {
  query: '哈勃张力争议的两派测量结论分别是什么？', ctx: {}, cfg: {},
  intent: 'cosmos', targets: [], route: route, capabilities: null,
  budget: budget(), forceCompare: false
};
var planOn = P.plan(Object.assign({}, planIn, { agentRuntime: true }));
var planOff = P.plan(Object.assign({}, planIn, { agentRuntime: false }));

eq('T-F 模板', planOn.template, 'T-F');
eq('Agent 步骤数', planOn.steps.length, 2);
eq('首步为 agent', planOn.steps[0].kind, 'agent');
eq('次步为 compose.domain', planOn.steps[1].tool, 'compose.domain');
eq('compose 依赖 t1', planOn.steps[1].deps, ['t1']);
ok('默认（无 agentRuntime）不出现 agent 步骤',
  planOff.steps.every(function (s) { return s.kind !== 'agent'; }));

/* ---------- 2. Orchestrator：Agent 成功 → 证据挂到步骤结果 ---------- */
function makeState(ev) {
  return {
    id: 'task-b-1', phase: 'EXECUTE', question: '哈勃张力争议', events: [],
    budget: budget(), evidence: ev ? [ev] : [], agentResults: [],
    steps: [T.makeStep({ id: 't1', tool: 'agent.research', kind: 'agent', status: 'pending', critical: true })]
  };
}
var ev1 = {
  evidenceId: 'ev-1', sourceType: 'paper', sourceId: 'openalex',
  title: 'Planck 2018 results VI', uri: 'https://doi.org/10.1051/0004-6361/201833910',
  snippet: 'H0 = 67.4 km/s/Mpc', retrievedAt: '2026-11-27T00:00:00.000Z',
  content: { doi: '10.1051/0004-6361/201833910' }
};
var state1 = makeState(ev1);
EX.run = function (planStep, opts) {
  return Promise.resolve(AR.create({
    taskId: opts.state.id, stepId: planStep.id, agentId: 'scholar', status: 'completed',
    objective: '检索证据', startedAt: Date.now() - 10, completedAt: Date.now(),
    toolCalls: [{ id: 'c1', name: 'paper.search', args: {}, status: 'ok', executionId: 'e1', evidenceIds: ['ev-1'] }],
    findings: [{ text: 'Planck 给出 67.4', level: 'inference', evidenceIds: ['ev-1'] }],
    evidenceIds: ['ev-1'],
    provenance: { provider: 'deepseek', promptVersion: 'scholar.v1', tools: ['paper.search'] }
  }));
};
var planStep = planOn.steps[0];
var r1 = O.Runner.executeOne(planStep, state1, {
  registry: null, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek'
});
Promise.resolve(r1).then(function (out1) {
  var st1 = state1.steps[0];
  ok('Agent 步骤成功', out1 && out1.ok === true);
  eq('步骤状态 ok', st1.status, 'ok');
  ok('步骤结果带真实证据 items', Array.isArray(st1.result.items) && st1.result.items.length === 1 &&
    st1.result.items[0].evidenceId === 'ev-1');
  eq('agentResults 保留 1 条', state1.agentResults.length, 1);

  /* ---------- 3. Orchestrator：Agent 抛异常 → 失败成果不丢失 ---------- */
  var state2 = makeState(null);
  EX.run = function () { throw new Error('executor boom'); };
  return O.Runner.executeOne(planOn.steps[0], state2, {
    registry: null, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek'
  }).then(function (out2) {
    var st2 = state2.steps[0];
    ok('异常步骤判定失败', out2 && out2.ok === false);
    eq('步骤状态 failed', st2.status, 'failed');
    eq('失败成果仍在 agentResults', state2.agentResults.length, 1);
    eq('失败成果 status', state2.agentResults[0].status, 'failed');
    eq('失败错误分类', state2.agentResults[0].errors[0].code, 'agent_failed');
    eq('步骤结果即失败成果', st2.result.status, 'failed');

    /* ---------- 4. Compose 真正消费 Agent findings ---------- */
    var adapter = CA.create({
      agentCore: {
        buildAnswer: function () { return { query: 'q', sections: [], meta: {}, targets: [] }; },
        defaultConfig: function () { return {}; }
      }
    });
    var dep = {
      t1: {
        agentId: 'scholar', status: 'completed',
        findings: [{ text: 'Planck 给出 67.4', level: 'inference', evidenceIds: ['ev-1'] }],
        evidenceIds: ['ev-1'], items: [ev1]
      }
    };
    var cr = adapter.compose({ query: '哈勃张力争议', intent: 'cosmos', from: ['t1'] }, {}, {}, dep);
    ok('compose 成功', cr && cr.ok === true);
    ok('compose 纳入 Agent 证据', (cr.evidenceIds || []).indexOf('ev-1') >= 0);
    ok('答案 research 挂载成功', !!(cr.answer && cr.answer.research));
    var byAgent = cr.answer && cr.answer.research && cr.answer.research.reducer &&
      cr.answer.research.reducer.byAgent;
    ok('reducer 记录 Agent findings', !!(byAgent && byAgent.scholar &&
      byAgent.scholar.findings && byAgent.scholar.findings.length >= 1));

    /* ---------- 5. 能力矩阵 ---------- */
    eq('scholar 可执行', EX.capability('scholar').executable, true);
    eq('curator 标记不可执行', EX.capability('curator').executable, false);

    console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
    if (failed) { console.log('失败项：' + failures.join('、')); process.exit(1); }
  });
}).catch(function (e) {
  console.log('  FAIL 未捕获异常 :: ' + (e && e.stack || e));
  process.exit(1);
});
