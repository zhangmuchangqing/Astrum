'use strict';
/* V2 P0-B · AgentResult 契约 + TaskState/Reducer 兼容扩展（离线、只读） */

var path = require('path');

var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
};

require(path.join(__dirname, '..', 'core', 'task.js'));
require(path.join(__dirname, '..', 'core', 'reducer.js'));
require(path.join(__dirname, '..', 'core', 'agent-result.js'));

var T = globalThis.AstroTask;
var R = globalThis.AstroReducer;
var AR = globalThis.AstroAgentResult;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function codes(v) { return (v.errors || []).map(function (e) { return e.code; }); }

function baseCtx() {
  return {
    taskId: 't1', stepId: 's1', agentId: 'scholar',
    agentIds: ['scholar', 'critic'],
    evidenceIndex: { ev1: true },
    toolExecutions: [{ executionId: 'exec-1', toolId: 'paper.search', ok: true }]
  };
}

function sample(over) {
  var o = {
    taskId: 't1', stepId: 's1', agentId: 'scholar', status: 'completed',
    objective: '检索 M31 论文',
    evidenceIds: ['ev1'],
    toolCalls: [{ name: 'paper.search', status: 'ok', executionId: 'exec-1', evidenceIds: ['ev1'] }],
    findings: [{ text: '存在相关论文', level: 'fact', evidenceIds: ['ev1'] }],
    provenance: { provider: 'deepseek', model: 'm', promptVersion: 'scholar.v1', tools: ['paper.search'], attempt: 1 }
  };
  Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
  return o;
}

async function main() {
  console.log('\n== P0-B AgentResult ==');

  /* 1. 合法成果 */
  var v1 = AR.validate(sample(), baseCtx());
  eq('合法成果 ok', v1.ok, true);
  eq('合法成果无错误', v1.errors.length, 0);
  eq('fact 保留', v1.result.findings[0].level, 'fact');

  /* 2. 未注册 Agent */
  var v2 = AR.validate(sample({ agentId: 'hacker' }), baseCtx());
  eq('未注册 Agent 失败', v2.ok, false);
  ok('未注册错误含 E_AGENT_UNKNOWN', codes(v2).indexOf('E_AGENT_UNKNOWN') >= 0, codes(v2).join(','));

  /* 3. 伪造工具成功（无真实执行记录） */
  var v3 = AR.validate(sample({
    toolCalls: [{ name: 'paper.search', status: 'ok', executionId: 'ghost', evidenceIds: [] }]
  }), baseCtx());
  eq('伪造工具失败', v3.ok, false);
  eq('伪造工具错误码', codes(v3), ['E_TOOL_UNVERIFIED']);

  /* 4. 不存在的证据被剔除并记限制 */
  var v4 = AR.validate(sample({ evidenceIds: ['ev1', 'ghost-ev'] }), baseCtx());
  eq('证据剔除后仍合法', v4.ok, true);
  eq('证据剔除结果', v4.result.evidenceIds, ['ev1']);
  ok('证据剔除有 limitation', v4.result.limitations.length >= 1);

  /* 5. 无证据 fact 降级为 inference */
  var v5 = AR.validate(sample({
    evidenceIds: [],
    findings: [{ text: '未引用证据的断言', level: 'fact', evidenceIds: [] }],
    toolCalls: []
  }), baseCtx());
  eq('fact 降级', v5.result.findings[0].level, 'inference');

  /* 6. taskId / stepId 不匹配 */
  eq('taskId 不匹配', codes(AR.validate(sample({ taskId: 't2' }), baseCtx())), ['E_TASK_MISMATCH']);
  eq('stepId 不匹配', codes(AR.validate(sample({ stepId: 's2' }), baseCtx())), ['E_STEP_MISMATCH']);

  /* 7. 非法 status */
  eq('非法 status', codes(AR.validate(sample({ status: 'done' }), baseCtx())), ['E_STATUS_INVALID']);

  /* 8. 缺 provenance 只记限制，不判失败 */
  var v8 = AR.validate(sample({ provenance: {} }), baseCtx());
  eq('缺 provenance 不失败', v8.ok, true);
  ok('缺 provenance 有 limitation', v8.result.limitations.length >= 1);

  /* 9. TaskState 新增字段可创建、可持久化、可恢复 */
  var st = T.create({
    id: 't-roundtrip',
    agentResults: [{ agentId: 'scholar', status: 'completed', evidenceIds: ['ev1'] }],
    cost: { provider: 'deepseek', model: 'm', totalTokens: 12, estimatedCost: null, currency: null }
  });
  eq('create 保留 agentResults', st.agentResults.length, 1);
  eq('create 保留 cost', st.cost.totalTokens, 12);
  var back = T.fromJSON(JSON.parse(JSON.stringify(st)));
  eq('fromJSON 保留 agentResults', back.agentResults.length, 1);
  eq('fromJSON 保留 cost', back.cost.totalTokens, 12);
  eq('schemaVersion 仍为 1', back.schemaVersion, 1);

  /* 10. 旧任务（无新字段）仍合法 */
  var legacy = T.create({ id: 't-legacy' });
  var legacyBack = T.fromJSON(JSON.parse(JSON.stringify(legacy)));
  eq('旧任务 agentResults 默认空数组', legacyBack.agentResults, []);
  eq('旧任务 cost 默认 null', legacyBack.cost, null);

  /* 11. Reducer：无 agentResults 时输出不变 */
  var base = R.reduce({ stepResults: {} });
  ok('旧输出无 byAgent', !Object.prototype.hasOwnProperty.call(base, 'byAgent'));
  ok('旧输出无 agentResults', !Object.prototype.hasOwnProperty.call(base, 'agentResults'));

  /* 12. Reducer：有 agentResults 时按 Agent 聚合，证据不重复 */
  var evidence = [{ evidenceId: 'ev1', sourceId: 'arxiv', sourceType: 'paper', title: 'Paper', content: 'c' }];
  var reduced = R.reduce({
    stepResults: {},
    evidence: evidence,
    agentResults: [
      {
        agentId: 'scholar', status: 'completed', evidenceIds: ['ev1'],
        findings: [{ text: 'f1', level: 'inference', evidenceIds: ['ev1'] }],
        limitations: [], claims: [], toolCalls: [{ name: 'paper.search', status: 'ok' }]
      },
      { agentId: 'critic', status: 'failed', evidenceIds: [], findings: [], limitations: ['x'], claims: [], toolCalls: [] }
    ]
  });
  ok('新增 byAgent', !!reduced.byAgent);
  eq('scholar 聚合状态', reduced.byAgent.scholar.status, 'completed');
  eq('scholar 工具计数', reduced.byAgent.scholar.toolCalls, 1);
  eq('证据未重复', reduced.evidence.length, 1);
  eq('失败 Agent 进入 agentFailures', reduced.agentFailures.length, 1);
  eq('agentEvidenceMissing 为空', reduced.agentEvidenceMissing.length, 0);

  /* 13. Reducer：引用不存在证据被记录，不伪造 */
  var reduced2 = R.reduce({
    stepResults: {},
    agentResults: [{ agentId: 'scholar', status: 'partial', evidenceIds: ['ghost'], findings: [], limitations: [], claims: [], toolCalls: [] }]
  });
  eq('缺失证据被记录', reduced2.agentEvidenceMissing.length, 1);
  eq('缺失证据不进入 evidence', reduced2.evidence.length, 0);

  console.log('\nP0-B 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
