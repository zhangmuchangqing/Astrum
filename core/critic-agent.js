/* ASTRUM · V2 P0-D 独立评审（CriticAgent）
 *
 * 定位：在答案交付前，对真实成果做独立、可复核的审查。
 * 边界：
 *   - 只读：不修改 Evidence、Claims、AgentResult 原始内容。
 *   - 不编造：无证据即判 NEEDS_EVIDENCE，不得因"模型说得好"而放行。
 *   - 可拒绝：FAIL 时给出原因与修复项，由 Control 决定是否补充取证。
 *   - 规则审查确定性可复现；不默认调用第二个模型（避免成本与不确定性）。
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  function arr(v) { return Array.isArray(v) ? v : []; }
  function uniq(list) {
    var seen = {}, out = [];
    arr(list).forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  function collectEvidence(state, input) {
    var items = [];
    if (Array.isArray(input && input.evidence)) items = items.concat(input.evidence);
    if (state && Array.isArray(state.evidence)) items = items.concat(state.evidence);
    var steps = (input && input.stepResults) || null;
    var list = steps ? Object.keys(steps).map(function (k) { return steps[k]; }) : [];
    if (!steps && state) list = arr(state.steps).map(function (s) { return s && s.result; }).filter(Boolean);
    list.forEach(function (r) {
      if (!r) return;
      arr(r.items).forEach(function (it) { if (it && it.evidenceId) items.push(it); });
      arr(r.evidenceIds).forEach(function (id) { if (id) items.push({ evidenceId: id }); });
    });
    var seen = {}, out = [];
    items.forEach(function (e) {
      if (!e || !e.evidenceId) return;
      if (seen[e.evidenceId]) return;
      seen[e.evidenceId] = 1;
      out.push(e);
    });
    return out;
  }

  function verdictsOf(state) {
    return arr(state && state.eval && state.eval.claimVerdicts);
  }

  function agentFailures(state) {
    return arr(state && state.agentResults).filter(function (r) {
      return r && ['failed', 'blocked', 'cancelled', 'timeout'].indexOf(r.status) >= 0;
    });
  }

  function unverifiedToolCalls(state) {
    var bad = [];
    arr(state && state.agentResults).forEach(function (r) {
      arr(r && r.toolCalls).forEach(function (c) {
        if (c && c.status === 'ok' && !c.executionId) bad.push(c.name || c.id || 'unknown');
      });
    });
    return bad;
  }

  function conflictsOf(answer) {
    var r = answer && answer.research;
    var reduced = r && (r.reduced || r.report);
    if (reduced && Array.isArray(reduced.conflicts)) return reduced.conflicts;
    if (r && Array.isArray(r.conflicts)) return r.conflicts;
    return [];
  }

  function review(input) {
    input = input || {};
    var state = input.state || {};
    var answer = input.answer || null;
    var findings = [];
    var requiredFixes = [];
    var missingEvidence = [];
    var rejectedEvidenceIds = [];
    var evidence = collectEvidence(state, input);
    var verdicts = verdictsOf(state);
    var failures = agentFailures(state);
    var badCalls = unverifiedToolCalls(state);
    var conflicts = conflictsOf(answer);
    var quality = (answer && answer.meta && answer.meta.quality) || null;
    var retired = !!input.retried;

    function add(code, severity, message, fix) {
      findings.push({ code: code, severity: severity, message: message });
      if (fix) requiredFixes.push(fix);
    }

    if (!answer) {
      add('E_NO_ANSWER', 'fail', '没有可交付答案', '重新执行或降级为无结论');
    }

    if (!evidence.length) {
      add('E_NO_EVIDENCE', 'fail', '没有任何可用证据', '补充检索并重新生成结论');
      missingEvidence.push(String(input.query || (state && state.question) || ''));
    }

    var requiredFailed = verdicts.filter(function (v) {
      return v && v.verdict === 'FAIL' && v.required !== false;
    });
    if (requiredFailed.length) {
      add('E_CLAIM_UNSUPPORTED', requiredFailed.length >= 3 ? 'fail' : 'warn',
        '有 ' + requiredFailed.length + ' 条必需断言未通过证据校验',
        '针对未通过断言补充独立证据');
      requiredFailed.slice(0, 3).forEach(function (v) {
        if (v.text || v.claimText) missingEvidence.push(v.text || v.claimText);
      });
    }

    if (badCalls.length) {
      add('E_TOOL_UNVERIFIED', 'fail', '存在缺少执行记录却标记成功的工具调用: ' + uniq(badCalls).join(','), '剔除伪造工具结果并重新执行');
    }

    if (failures.length) {
      add('E_AGENT_FAILED', 'warn',
        '有 ' + failures.length + ' 个 Agent 未正常完成（' + failures.map(function (f) { return f.agentId + ':' + f.status; }).join(',') + '）',
        '补齐失败 Agent 的任务或在结论中声明缺口');
    }

    if (conflicts.length) {
      add('E_CONFLICT_UNRESOLVED', 'warn', '存在未消解的结论冲突（' + conflicts.length + '）', '在结论中并列呈现冲突与不确定性');
    }

    if (quality && (quality.passed === false || (Array.isArray(quality.unsupportedNumbers) && quality.unsupportedNumbers.length))) {
      add('E_UNSUPPORTED_NUMBER', 'warn', '答案包含未溯源数字', '删除或补充数字来源');
    }

    var sourceIds = uniq(evidence.map(function (e) { return e.sourceId || e.source; }));
    if (evidence.length && sourceIds.length < 2) {
      add('E_SINGLE_SOURCE', 'warn', '结论仅依赖单一来源', '补充第二个独立来源');
    }

    var hasUnknowns = verdicts.some(function (v) { return v && v.verdict !== 'PASS'; });
    if (hasUnknowns && !(answer && (Array.isArray(answer.limitations) && answer.limitations.length))) {
      add('E_NO_LIMITATIONS', 'warn', '存在未通过断言但答案未声明不确定性', '补充能力边界与不确定性说明');
    }

    var fatal = findings.filter(function (f) { return f.severity === 'fail'; });
    var warns = findings.filter(function (f) { return f.severity === 'warn'; });
    var verdict;
    if (!answer || badCalls.length) verdict = 'FAIL';
    else if (!evidence.length) verdict = retired ? 'FAIL' : 'NEEDS_EVIDENCE';
    else if (requiredFailed.length) verdict = retired ? 'FAIL' : 'NEEDS_EVIDENCE';
    else if (fatal.length) verdict = 'FAIL';
    else if (warns.length) verdict = 'PARTIAL';
    else verdict = 'PASS';

    var retryable = verdict === 'NEEDS_EVIDENCE' && !retired;

    return {
      version: VERSION,
      verdict: verdict,
      findings: findings,
      requiredFixes: uniq(requiredFixes),
      missingEvidence: uniq(missingEvidence).slice(0, 3),
      rejectedEvidenceIds: rejectedEvidenceIds,
      evidenceCount: evidence.length,
      sourceCount: sourceIds.length,
      conflictCount: conflicts.length,
      agentFailureCount: failures.length,
      retryable: retryable,
      degraded: false,
      checkedAt: new Date().toISOString()
    };
  }

  /* 只附加评审信息与边界说明，不删除任何原始证据或结论。 */
  function applyToAnswer(answer, result) {
    if (!answer || !result) return answer;
    answer.meta = answer.meta || {};
    answer.meta.critic = result;
    if (result.verdict !== 'PASS') {
      var boundary = '独立评审：' + result.verdict +
        (result.requiredFixes.length ? '；待补：' + result.requiredFixes.join('；') : '');
      if (Array.isArray(answer.limitations)) answer.limitations.push(boundary);
      else {
        answer.meta.limitations = Array.isArray(answer.meta.limitations) ? answer.meta.limitations : [];
        answer.meta.limitations.push(boundary);
      }
    }
    return answer;
  }

  root.AstroCriticAgent = {
    version: VERSION,
    review: review,
    applyToAnswer: applyToAnswer
  };
})(typeof window !== 'undefined' ? window : globalThis);
