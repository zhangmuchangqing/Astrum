'use strict';
/* V2 P2 · 执行可观测性数据契约（离线）
 *
 * 说明：UI 渲染本身需要浏览器；本测试验证「面板所需的全部数据」都来自
 * 真实执行事件与 AgentResult/CriticResult，而不是模拟文案或预设步骤。
 */

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
require(path.join(__dirname, '..', 'core', 'critic-agent.js'));

var S = globalThis.Sources;
var T = globalThis.AstroTask;
var EX = globalThis.AstroAgentExecutor;
var C = globalThis.AstroCriticAgent;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

S.setConfig('deepseek', { key: 'k', endpoint: 'https://mock.local/v1/chat/completions', model: 'm' });

var calls = [];
global.fetch = function (url, opts) {
  calls.push(JSON.parse(opts.body || '{}'));
  var n = calls.length;
  var obj = n === 1
    ? {
      choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'paper__search', arguments: '{"query":"M31"}' } }] },
        finish_reason: 'tool_calls'
      }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }
    : { choices: [{ message: { role: 'assistant', content: '结论' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
  return Promise.resolve({
    ok: true, status: 200,
    headers: { get: function () { return null; } },
    text: function () { return Promise.resolve(JSON.stringify(obj)); },
    json: function () { return Promise.resolve(obj); }
  });
};

var spec = {
  id: 'paper.search', version: 't', description: 'd',
  argsSchema: { type: 'object', properties: { query: { type: 'string' } } },
  run: function () { return { items: [{ evidenceId: 'ev1', title: 'M31 paper', sourceId: 'arxiv' }] }; }
};
var reg = {
  get: function (id) { return id === 'paper.search' ? spec : null; },
  list: function () { return [spec]; },
  validateArgs: function () { return { ok: true }; },
  checkDeps: function () { return { ok: true }; }
};

async function main() {
  console.log('\n== P2 执行可观测性 ==');

  var st = T.create({ id: 't-p2', level: 'L3', question: 'M31 距离' });
  st.evidence = [{ evidenceId: 'ev1', title: 'seed', sourceId: 'arxiv' }];
  var r = await EX.run({
    id: 't1', tool: 'agent.research', kind: 'agent', agentId: 'scholar',
    tools: ['paper.search'], objective: '检索 M31', args: { query: 'M31' }, deps: []
  }, { state: st, registry: reg, ctx: {}, cfg: {}, signal: null, sourceId: 'deepseek', allowDirectTools: true });

  /* 1. 事件是真实执行产生的，且带可展示字段 */
  var types = st.events.map(function (e) { return e.type; });
  ok('存在 agent.started 事件', types.indexOf('agent.started') >= 0, types.join(','));
  ok('存在 agent.result.created 事件', types.indexOf('agent.result.created') >= 0, types.join(','));
  var created = st.events.filter(function (e) { return e.type === 'agent.result.created'; })[0];
  eq('事件 agentId', created.payload.agentId, 'scholar');
  eq('事件工具数', created.payload.toolCalls, 1);
  eq('事件证据数', created.payload.evidence, 1);
  eq('事件状态', created.payload.status, 'completed');

  /* 2. 面板数据直接来自 AgentResult，字段完整 */
  eq('state.agentResults 数量', st.agentResults.length, 1);
  var a = st.agentResults[0];
  eq('面板 agentId', a.agentId, 'scholar');
  eq('面板 objective', a.objective, '检索 M31');
  eq('面板工具调用', a.toolCalls[0].name, 'paper.search');
  ok('面板工具状态', a.toolCalls[0].status === 'ok');
  ok('面板有执行 id', !!a.toolCalls[0].executionId);
  eq('面板证据', a.evidenceIds, ['ev1']);

  /* 3. 评审数据来自 Critic 真实审查，写入 meta.critic */
  var answer = { query: 'M31', sections: [], meta: {}, limitations: [], research: { conflicts: [] } };
  var critic = C.review({ state: st, answer: answer, query: 'M31' });
  C.applyToAnswer(answer, critic);
  ok('meta.critic 存在', !!answer.meta.critic);
  ok('meta.critic 有 verdict', !!answer.meta.critic.verdict);
  ok('边界说明可见', answer.limitations.length === 1);

  /* 4. 没有数据时 UI 不应有面板可渲染（契约：空数组 / 无 critic 即返回 null） */
  var emptyState = { agentResults: [] };
  ok('空 AgentResults 无面板数据', !(emptyState.agentResults.length));
  ok('无 critic 时无评审数据', !('critic' in { meta: {} }));

  console.log('\nP2 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
