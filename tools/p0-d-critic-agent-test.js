'use strict';
/* V2 P0-D · CriticAgent 独立评审（离线、只读、确定性） */

var path = require('path');
require(path.join(__dirname, '..', 'core', 'critic-agent.js'));

var C = globalThis.AstroCriticAgent;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function codes(r) { return (r.findings || []).map(function (f) { return f.code; }); }

function ev(id, sourceId) {
  return { evidenceId: id, sourceId: sourceId, title: 't-' + id, sourceType: 'paper' };
}
function answer(over) {
  var a = { sections: [], meta: {}, limitations: [], research: { conflicts: [] } };
  Object.keys(over || {}).forEach(function (k) { a[k] = over[k]; });
  return a;
}

function main() {
  console.log('\n== P0-D CriticAgent ==');

  /* 1. 合格：两条独立来源 + 全部断言通过 */
  var s1 = {
    evidence: [ev('e1', 'arxiv'), ev('e2', 'openalex')],
    eval: { claimVerdicts: [{ claimId: 'c1', verdict: 'PASS' }] },
    agentResults: []
  };
  var r1 = C.review({ state: s1, answer: answer(), query: 'M31' });
  eq('合格 verdict', r1.verdict, 'PASS');
  eq('合格无修复项', r1.requiredFixes.length, 0);
  eq('合格证据数', r1.evidenceCount, 2);
  eq('合格来源数', r1.sourceCount, 2);

  /* 2. 无证据 → NEEDS_EVIDENCE（可补证） */
  var r2 = C.review({ state: { evidence: [], eval: {}, agentResults: [] }, answer: answer(), query: 'M31 距离' });
  eq('无证据 verdict', r2.verdict, 'NEEDS_EVIDENCE');
  eq('无证据可补证', r2.retryable, true);
  eq('无证据缺口', r2.missingEvidence, ['M31 距离']);
  ok('无证据有 E_NO_EVIDENCE', codes(r2).indexOf('E_NO_EVIDENCE') >= 0);

  /* 3. 补证后仍无证据 → FAIL */
  var r3 = C.review({ state: { evidence: [], eval: {}, agentResults: [] }, answer: answer(), query: 'M31 距离', retried: true });
  eq('补证后无证据 FAIL', r3.verdict, 'FAIL');
  eq('补证后不可再补', r3.retryable, false);

  /* 4. 必需断言未通过 → 先 NEEDS_EVIDENCE，补证后 FAIL */
  var s4 = {
    evidence: [ev('e1', 'arxiv'), ev('e2', 'openalex')],
    eval: { claimVerdicts: [{ claimId: 'c1', verdict: 'FAIL', required: true, text: '距离为 780 kpc' }] },
    agentResults: []
  };
  var r4a = C.review({ state: s4, answer: answer(), query: 'M31' });
  eq('断言失败先补证', r4a.verdict, 'NEEDS_EVIDENCE');
  eq('断言缺口被列出', r4a.missingEvidence, ['距离为 780 kpc']);
  var r4b = C.review({ state: s4, answer: answer(), query: 'M31', retried: true });
  eq('断言补证后 FAIL', r4b.verdict, 'FAIL');

  /* 5. Agent 失败 → PARTIAL */
  var s5 = {
    evidence: [ev('e1', 'arxiv'), ev('e2', 'openalex')],
    eval: { claimVerdicts: [{ claimId: 'c1', verdict: 'PASS' }] },
    agentResults: [{ agentId: 'scholar', status: 'failed', toolCalls: [] }]
  };
  var r5 = C.review({ state: s5, answer: answer(), query: 'M31' });
  eq('Agent 失败 verdict', r5.verdict, 'PARTIAL');
  ok('Agent 失败有 E_AGENT_FAILED', codes(r5).indexOf('E_AGENT_FAILED') >= 0);

  /* 6. 伪造工具成功（无 executionId）→ FAIL */
  var s6 = {
    evidence: [ev('e1', 'arxiv'), ev('e2', 'openalex')],
    eval: { claimVerdicts: [] },
    agentResults: [{ agentId: 'scholar', status: 'completed', toolCalls: [{ name: 'paper.search', status: 'ok' }] }]
  };
  var r6 = C.review({ state: s6, answer: answer(), query: 'M31' });
  eq('伪造工具 verdict', r6.verdict, 'FAIL');
  ok('伪造工具有 E_TOOL_UNVERIFIED', codes(r6).indexOf('E_TOOL_UNVERIFIED') >= 0);

  /* 7. 冲突未消解 → PARTIAL */
  var a7 = answer({ research: { conflicts: [{ a: 'x', b: 'y' }] } });
  var r7 = C.review({ state: s1, answer: a7, query: 'M31' });
  eq('冲突 verdict', r7.verdict, 'PARTIAL');
  ok('冲突有 E_CONFLICT_UNRESOLVED', codes(r7).indexOf('E_CONFLICT_UNRESOLVED') >= 0);

  /* 8. 未溯源数字 → PARTIAL */
  var a8 = answer({ meta: { quality: { passed: false, unsupportedNumbers: ['780'] } } });
  var r8 = C.review({ state: s1, answer: a8, query: 'M31' });
  eq('未溯源数字 verdict', r8.verdict, 'PARTIAL');
  ok('未溯源数字有 E_UNSUPPORTED_NUMBER', codes(r8).indexOf('E_UNSUPPORTED_NUMBER') >= 0);

  /* 9. 单一来源 → PARTIAL */
  var s9 = { evidence: [ev('e1', 'arxiv')], eval: { claimVerdicts: [{ claimId: 'c1', verdict: 'PASS' }] }, agentResults: [] };
  var r9 = C.review({ state: s9, answer: answer(), query: 'M31' });
  eq('单来源 verdict', r9.verdict, 'PARTIAL');
  ok('单来源有 E_SINGLE_SOURCE', codes(r9).indexOf('E_SINGLE_SOURCE') >= 0);

  /* 10. applyToAnswer 只附加，不删证据 */
  var state10 = { evidence: [ev('e1', 'arxiv')], eval: {}, agentResults: [] };
  var before = JSON.stringify(state10.evidence);
  var a10 = answer();
  C.applyToAnswer(a10, r9);
  eq('评审写入 meta', a10.meta.critic.verdict, 'PARTIAL');
  ok('边界说明已追加', a10.limitations.length === 1 && /独立评审/.test(a10.limitations[0]));
  eq('证据未被修改', JSON.stringify(state10.evidence), before);

  /* 11. 确定性：同一输入重复评审一致 */
  var r11a = C.review({ state: s1, answer: answer(), query: 'M31' });
  var r11b = C.review({ state: s1, answer: answer(), query: 'M31' });
  eq('确定性 verdict', r11a.verdict, r11b.verdict);
  eq('确定性 findings 数', r11a.findings.length, r11b.findings.length);

  console.log('\nP0-D 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main();
