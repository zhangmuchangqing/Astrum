'use strict';
/* V2 P3 · LLM 规划器（mock 模型，强制 DAG 校验，失败回退） */

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
require(path.join(__dirname, '..', 'core', 'dag-validator.js'));
require(path.join(__dirname, '..', 'core', 'model-gateway.js'));
require(path.join(__dirname, '..', 'core', 'planner.js'));

var S = globalThis.Sources;
var P = globalThis.AstroPlanner;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

S.setConfig('deepseek', { key: 'k', endpoint: 'https://mock.local/v1/chat/completions', model: 'm' });

var calls = 0;
function mockModel(text) {
  calls = 0;
  global.fetch = function () {
    calls += 1;
    var obj = {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    };
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: function () { return null; } },
      text: function () { return Promise.resolve(JSON.stringify(obj)); },
      json: function () { return Promise.resolve(obj); }
    });
  };
}

function makeReg(extra) {
  var specs = {
    'paper.search': { id: 'paper.search', description: '检索论文' },
    'evidence.search': { id: 'evidence.search', description: '检索证据' },
    'compose.domain': { id: 'compose.domain', description: '汇总' }
  };
  Object.keys(extra || {}).forEach(function (k) { specs[k] = extra[k]; });
  return {
    get: function (id) { return specs[id] || null; },
    list: function () { return Object.keys(specs).map(function (k) { return specs[k]; }); },
    validateArgs: function () { return { ok: true }; },
    checkDeps: function () { return { ok: true }; }
  };
}

var GOOD = JSON.stringify({
  steps: [
    { id: 't1', tool: 'paper.search', args: { query: 'M31' }, deps: [], critical: true, objective: '检索 M31 论文' },
    { id: 't2', tool: 'compose.domain', args: { from: ['t1'] }, deps: ['t1'], critical: false, objective: '汇总' }
  ]
});

function planWith(text, reg, source) {
  mockModel(text);
  return P.planWithModel({ query: 'M31 距离' }, { registry: reg || makeReg(), sourceId: source === undefined ? 'deepseek' : source });
}

(async function main() {
  console.log('\n== P3 LLM Planner ==');

  /* 1. 合法计划 */
  var r1 = await planWith(GOOD);
  eq('合法计划 ok', r1.ok, true);
  eq('合法计划步骤数', r1.plan.steps.length, 2);
  eq('步骤工具', r1.plan.steps[0].tool, 'paper.search');
  eq('依赖保留', r1.plan.steps[1].deps, ['t1']);
  eq('objective 保留', r1.plan.steps[0].objective, '检索 M31 论文');
  eq('basis', r1.plan.basis, 'llm');
  eq('默认带 postCritic', r1.plan.postCritic, true);

  /* 2. 代码围栏 JSON 也能解析 */
  var fenced = '```json\n' + GOOD + '\n```';
  var r2 = await planWith(fenced);
  eq('围栏 JSON ok', r2.ok, true);

  /* 3. 未注册工具必须拒绝 */
  var badTool = JSON.stringify({ steps: [{ id: 't1', tool: 'hack.tool', args: {}, deps: [], critical: true }] });
  var r3 = await planWith(badTool);
  eq('未注册工具 ok=false', r3.ok, false);
  ok('未注册工具原因', String(r3.reason).indexOf('tool_not_allowed') === 0, r3.reason);

  /* 4. 依赖不存在 → DAG 校验失败 */
  var badDep = JSON.stringify({ steps: [{ id: 't1', tool: 'paper.search', args: {}, deps: ['t9'], critical: true }] });
  var r4 = await planWith(badDep);
  eq('未知依赖 ok=false', r4.ok, false);
  eq('未知依赖原因', r4.reason, 'dag_invalid');

  /* 5. 环依赖 → DAG 校验失败 */
  var cyclic = JSON.stringify({
    steps: [
      { id: 't1', tool: 'paper.search', args: {}, deps: ['t2'], critical: true },
      { id: 't2', tool: 'evidence.search', args: {}, deps: ['t1'], critical: false }
    ]
  });
  var r5 = await planWith(cyclic);
  eq('环依赖 ok=false', r5.ok, false);
  eq('环依赖原因', r5.reason, 'dag_invalid');

  /* 6. 非法 JSON */
  var r6 = await planWith('这不是 JSON');
  eq('非法 JSON ok=false', r6.ok, false);
  eq('非法 JSON 原因', r6.reason, 'planner_invalid_json');

  /* 7. 步骤数超限 */
  var many = { steps: [] };
  for (var i = 1; i <= 7; i++) many.steps.push({ id: 't' + i, tool: 'paper.search', args: {}, deps: [], critical: i === 1 });
  var r7 = await planWith(JSON.stringify(many));
  eq('步骤超限 ok=false', r7.ok, false);
  eq('步骤超限原因', r7.reason, 'planner_step_count');

  /* 8. 无 critical → DAG 校验失败 */
  var noCritical = JSON.stringify({ steps: [{ id: 't1', tool: 'paper.search', args: {}, deps: [], critical: false }] });
  var r8 = await planWith(noCritical);
  eq('无 critical ok=false', r8.ok, false);
  eq('无 critical 原因', r8.reason, 'dag_invalid');

  /* 9. 无模型来源 → 不调用模型 */
  var r9 = await planWith(GOOD, makeReg(), null);
  eq('无来源 ok=false', r9.ok, false);
  eq('无来源原因', r9.reason, 'planner_unavailable');
  eq('无来源不发请求', calls, 0);

  /* 10. 默认模板规划不受影响（不触发模型） */
  calls = 0;
  var base = P.plan({ query: 'M31 距离', route: { mode: 'research' }, targets: [], registry: makeReg(), capabilities: null });
  ok('默认模板仍可用', !!base && Array.isArray(base.steps) && base.steps.length > 0);
  eq('默认模板不调用模型', calls, 0);

  console.log('\nP3 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
})().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
