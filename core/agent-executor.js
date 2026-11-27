/* ASTRUM · V2 P0-C Agent 执行器（AgentExecutor）
 *
 * 定位：把「角色 → 模型 → 工具 → 成果」串成真实闭环。
 * 边界：
 *   - 模型只能"提出"工具调用；执行权在 ToolGateway / registry，绝不旁路。
 *   - 工具白名单 = Agent 定义 ∩ registry，且受 Security 二次约束。
 *   - 不伪造工具成功：只有真实执行返回的结果才进入 AgentResult。
 *   - 不修改 Evidence/Claims/Reducer；只产出 AgentResult。
 *   - 默认不启用；由 Control 在显式开关 + 可用云模型来源时调用。
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_TURNS = 4;
  var MAX_TOOL_CALLS = 6;
  var TOOL_RESULT_CHARS = 1200;

  /* Agent 定义（P0-C 只启用 Scholar；其余保留最小可用定义）。 */
  var DEFS = {
    scholar: {
      id: 'scholar',
      promptVersion: 'scholar.v1',
      tools: ['paper.search', 'evidence.search'],
      system: [
        '你是 ASTRUM 的文献检索 Agent（Scholar）。',
        '你只能通过提供的工具获取资料，不得凭记忆编造论文、作者、年份、数字或结论。',
        '每次需要资料时必须调用工具；工具返回为空时如实说明，不要补造。',
        '最终用中文给出不超过 200 字的结论，并说明证据是否足以支持该结论。'
      ].join('\n')
    },
    curator: {
      id: 'curator',
      promptVersion: 'curator.v1',
      tools: [],
      system: '你是 ASTRUM 的资料整理 Agent。只能整理已提供的材料，不得新增事实。'
    },
    muse: {
      id: 'muse',
      promptVersion: 'muse.v1',
      tools: [],
      system: '你是 ASTRUM 的研究协调 Agent。只能基于已有工具结果作答，不得编造。'
    }
  };

  function arr(v) { return Array.isArray(v) ? v : []; }

  function aliasOf(id) {
    /* 供应商函数名不允许点号；与 P0-A 约定一致：paper.search → paper__search */
    return String(id || '').replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function buildAliasMap(ids) {
    var byAlias = {}, byId = {};
    ids.forEach(function (id) {
      var a = aliasOf(id);
      var n = 1, base = a;
      while (byAlias[a] && byAlias[a] !== id) { n += 1; a = base + '_' + n; }
      byAlias[a] = id;
      byId[id] = a;
    });
    return { byAlias: byAlias, byId: byId };
  }

  function definitionOf(agentId) {
    var d = DEFS[agentId];
    if (d) return d;
    return {
      id: agentId || 'agent',
      promptVersion: String(agentId || 'agent') + '.v1',
      tools: [],
      system: '你是 ASTRUM 的专业 Agent。只能使用工具返回的真实材料，不得编造。'
    };
  }

  function available() {
    var S = root.Sources;
    if (!S || typeof S.list !== 'function') return null;
    var list = [];
    try { list = S.list() || []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it.type !== 'cloud') continue;
      var ok = false;
      try { ok = !!(S.hasKey && S.hasKey(it.id)); } catch (e2) { ok = false; }
      if (ok) return it.id;
    }
    return null;
  }

  function evidenceIndexOf(state) {
    var idx = {};
    arr(state && state.evidence).forEach(function (e) {
      if (e && e.evidenceId) idx[e.evidenceId] = e;
    });
    arr(state && state.steps).forEach(function (s) {
      if (!s || !s.result) return;
      arr(s.result.items).forEach(function (it) {
        if (it && it.evidenceId) idx[it.evidenceId] = it;
      });
      arr(s.result.evidenceIds).forEach(function (id) {
        if (id && !idx[id]) idx[id] = { evidenceId: id };
      });
    });
    return idx;
  }

  function depContext(state, planStep) {
    var parts = [];
    arr(planStep && planStep.deps).forEach(function (id) {
      var s = state && (state.steps || []).filter(function (x) { return x.id === id; })[0];
      if (!s || !s.result) return;
      arr(s.result.items).slice(0, 3).forEach(function (it) {
        if (it && (it.title || it.snippet)) parts.push('- ' + String(it.title || it.snippet).slice(0, 160));
      });
    });
    return parts.slice(0, 8).join('\n');
  }

  function evidenceIdsOf(raw) {
    if (!raw) return [];
    if (Array.isArray(raw.evidenceIds)) return raw.evidenceIds.slice();
    return arr(raw.items).map(function (x) { return x && x.evidenceId; }).filter(Boolean);
  }

  function summarizeToolResult(raw) {
    if (!raw || typeof raw !== 'object') return String(raw == null ? '' : raw).slice(0, TOOL_RESULT_CHARS);
    var items = arr(raw.items).slice(0, 5).map(function (it) {
      return {
        evidenceId: it && it.evidenceId,
        title: it && (it.title || '').slice(0, 200),
        source: it && (it.sourceId || it.source)
      };
    });
    var payload = { ok: raw.ok !== false, count: arr(raw.items).length, items: items };
    if (raw.error) payload.error = String(raw.error.message || raw.error).slice(0, 200);
    var s = JSON.stringify(payload);
    return s.length > TOOL_RESULT_CHARS ? s.slice(0, TOOL_RESULT_CHARS) + '…' : s;
  }

  function newExecutionId(state, planStep, turn, index) {
    return [state && state.id || 'task', planStep && planStep.id || 'step', 'a' + turn, 'c' + index].join(':');
  }

  async function invokeTool(toolId, args, ctx) {
    var opts = ctx.opts;
    var signal = opts.signal || null;
    if (signal && signal.aborted) {
      return { ok: false, error: { kind: 'cancelled', message: '已取消', retriable: false }, aborted: true };
    }
    if (root.ToolGateway && opts.principal) {
      var principal = opts.principal;
      if (root.Security && root.Security.delegate) {
        principal = root.Security.delegate(opts.principal, ctx.agentId, opts.principal.projectId) || opts.principal;
      }
      return root.ToolGateway.invoke(principal, toolId, args, {
        registry: opts.registry, ctx: opts.ctx, cfg: opts.cfg,
        signal: signal, taskId: ctx.state.id, attempt: 1,
        executionId: ctx.executionId, idempotencyKey: ctx.idempotencyKey
      });
    }
    /* W1：无执行主体时必须显式允许直调（仅离线测试），生产默认拒绝，
     * 防止绕过 ToolGateway 的授权、审计与幂等控制。 */
    if (opts.allowDirectTools !== true) {
      return {
        ok: false,
        error: { kind: 'permission', message: '缺少执行主体，已拒绝直接调用工具: ' + toolId, retriable: false }
      };
    }
    var spec = opts.registry && opts.registry.get ? opts.registry.get(toolId) : null;
    if (!spec || typeof spec.run !== 'function') {
      return { ok: false, error: { kind: 'tool_missing', message: '工具未注册: ' + toolId, retriable: false } };
    }
    return spec.run(args || {}, opts.ctx, spec, opts.cfg, {}, {
      signal: signal, taskId: ctx.state.id, attempt: 1,
      executionId: ctx.executionId, idempotencyKey: ctx.idempotencyKey
    });
  }

  async function run(planStep, opts) {
    opts = opts || {};
    var state = opts.state;
    var T = root.AstroTask;
    var Gateway = root.AstroModelGateway;
    var AR = root.AstroAgentResult;
    var startedAt = Date.now();
    var agentId = (planStep && planStep.agentId) || '';
    var def = definitionOf(agentId);
    var signal = opts.signal || null;

    var errors = [];
    var limitations = [];
    var calls = [];
    var messages = [];
    var collectedEvidence = [];
    var finalText = '';
    var status = 'running';
    var turn = 0;
    var callCount = 0;

    var result = {
      taskId: state ? state.id : '',
      stepId: planStep ? planStep.id : '',
      agentId: agentId,
      objective: (planStep && (planStep.objective || (planStep.args && planStep.args.query))) || (state && state.question) || '',
      startedAt: startedAt
    };

    try {
      if (!T || !Gateway || !AR) throw new Error('AgentExecutor 依赖未加载');
      if (!state) throw new Error('缺少任务状态');
      if (!agentId) throw new Error('缺少 agentId');

      /* 白名单：Agent 定义 ∩ registry（且必须真实存在）。 */
      var wanted = arr(planStep.tools).length ? arr(planStep.tools) : arr(def.tools);
      var allowed = [];
      wanted.forEach(function (id) {
        var spec = opts.registry && opts.registry.get ? opts.registry.get(id) : null;
        if (spec) allowed.push({ id: id, spec: spec });
      });
      if (!allowed.length) {
        limitations.push('没有可用工具，Agent 只能基于已有上下文作答');
      }
      var aliases = buildAliasMap(allowed.map(function (x) { return x.id; }));
      var toolDefs = allowed.map(function (x) {
        return {
          name: aliases.byId[x.id],
          description: x.spec.description || x.spec.id || x.id,
          parameters: x.spec.argsSchema || { type: 'object', properties: {} }
        };
      });

      var sourceId = opts.sourceId || (opts.cfg && (opts.cfg.sourceId || opts.cfg.source)) || available();
      if (!sourceId) throw new Error('没有可用的云模型来源');

      var contextText = [
        '任务问题：' + ((state.question || result.objective || '').slice(0, 500)),
        depContext(state, planStep) ? '前序结果摘要：\n' + depContext(state, planStep) : '',
        allowed.length ? '可用工具：' + allowed.map(function (x) { return x.id; }).join(', ') : ''
      ].filter(Boolean).join('\n');

      messages = [
        { role: 'system', content: def.system },
        { role: 'user', content: contextText + '\n\n请开始工作。' }
      ];

      if (T.appendEvent) {
        try { T.appendEvent(state, 'agent.started', { agentId: agentId, objective: result.objective }, planStep && planStep.id); }
        catch (e0) { /* ignore */ }
      }

      for (turn = 1; turn <= MAX_TURNS; turn++) {
        if (signal && signal.aborted) { status = 'cancelled'; limitations.push('执行被取消'); break; }
        if (T.canAfford && !T.canAfford(state.budget, { llmCalls: 1 })) {
          status = 'blocked';
          limitations.push('模型调用预算不足');
          break;
        }

        var resp = await Gateway.generate({
          sourceId: sourceId,
          agentId: agentId,
          messages: messages,
          tools: toolDefs,
          signal: signal,
          state: state,
          timeoutMs: 60000,
          maxRetries: 0,
          /* 工具决策必须基于当前证据，禁用跨任务缓存复用。 */
          cache: false
        });

        if (!resp || resp.status === 'aborted') { status = 'cancelled'; limitations.push('执行被取消'); break; }
        if (resp.status !== 'completed') {
          errors.push({ code: (resp.error && resp.error.code) || 'MODEL_ERROR', message: (resp.error && resp.error.message) || '模型调用失败' });
          break;
        }
        if (!resp.toolCalls || !resp.toolCalls.length) { finalText = resp.text || ''; status = 'completed'; break; }

        messages.push({ role: 'assistant', content: resp.text || '', toolCalls: resp.toolCalls });

        for (var i = 0; i < resp.toolCalls.length; i++) {
          var tc = resp.toolCalls[i] || {};
          var toolId = aliases.byAlias[tc.name] || null;
          var rec = {
            id: tc.id || '', name: toolId || tc.name, args: tc.arguments || {},
            status: 'rejected', executionId: null, evidenceIds: [], error: null
          };
          calls.push(rec);

          if (callCount >= MAX_TOOL_CALLS) {
            rec.error = { code: 'TOOL_CALL_LIMIT', message: '工具调用次数超过上限' };
            messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: '{"ok":false,"error":"TOOL_CALL_LIMIT"}' });
            continue;
          }
          if (!toolId) {
            rec.error = { code: 'TOOL_NOT_ALLOWED', message: '工具不在白名单: ' + tc.name };
            messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: '{"ok":false,"error":"TOOL_NOT_ALLOWED"}' });
            continue;
          }
          var spec = opts.registry.get(toolId);
          if (opts.registry.validateArgs) {
            var vr = opts.registry.validateArgs(toolId, rec.args);
            if (!vr.ok) {
              rec.error = { code: 'ARGS_INVALID', message: (vr.errors || []).map(function (e) { return e.path + ' ' + e.reason; }).join('; ') };
              messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: summarizeToolResult({ ok: false, error: rec.error }) });
              continue;
            }
          }
          callCount += 1;
          var executionId = newExecutionId(state, planStep, turn, i);
          rec.executionId = executionId;
          var idempotencyKey = T.sha256Hex ? T.sha256Hex([state.id, planStep.id, toolId, executionId].join('|')) : executionId;
          var raw = await invokeTool(toolId, rec.args, {
            opts: opts, state: state, agentId: agentId,
            executionId: executionId, idempotencyKey: idempotencyKey
          });
          if (raw && raw.aborted) { status = 'cancelled'; limitations.push('工具执行被取消'); break; }
          var ok = !(raw && raw.ok === false) && !(raw && raw.error && raw.error.kind === 'cancelled');
          rec.status = ok ? 'ok' : 'failed';
          rec.evidenceIds = ok ? evidenceIdsOf(raw) : [];
          if (!ok) rec.error = (raw && raw.error) || { code: 'TOOL_FAILED', message: '工具执行失败' };
          if (ok) collectedEvidence = collectedEvidence.concat(rec.evidenceIds);
          messages.push({
            role: 'tool', toolCallId: tc.id, name: tc.name,
            content: sanitize(summarizeToolResult(raw))
          });
        }
        if (status === 'cancelled') break;
        if (callCount >= MAX_TOOL_CALLS) {
          limitations.push('达到工具调用上限，提前收尾');
          break;
        }
      }

      if (turn > MAX_TURNS) limitations.push('达到模型轮次上限');
      if (status === 'running') {
        if (errors.length) status = 'failed';
        else if (limitations.length) status = 'partial';
        else status = 'completed';
      }
    } catch (e) {
      errors.push({ code: (e && e.code) || 'AGENT_ERROR', message: (e && e.message) || String(e) });
      status = 'failed';
    }

    var evidenceIndex = evidenceIndexOf(state);
    var evidenceIds = collectedEvidence.filter(function (v, i, a) { return a.indexOf(v) === i; });
    var findings = [];
    evidenceIds.forEach(function (id) {
      var ev = evidenceIndex[id];
      findings.push({
        text: (ev && (ev.title || ev.snippet)) || ('证据 ' + id),
        level: 'inference',
        evidenceIds: [id]
      });
    });
    if (finalText) {
      findings.push({ text: finalText.slice(0, 1200), level: 'inference', evidenceIds: evidenceIds });
    }
    if (!evidenceIds.length && status === 'completed') {
      limitations.push('未获得可用证据');
    }

    var built = AR.create({
      taskId: result.taskId,
      stepId: result.stepId,
      agentId: agentId,
      status: status,
      objective: result.objective,
      startedAt: startedAt,
      completedAt: Date.now(),
      actions: [
        { ts: startedAt, type: 'agent.start', detail: agentId },
        { ts: Date.now(), type: 'agent.end', detail: status }
      ],
      toolCalls: calls,
      findings: findings,
      evidenceIds: evidenceIds,
      claims: [],
      sources: evidenceIds.map(function (id) { return (evidenceIndex[id] && evidenceIndex[id].sourceId) || null; }).filter(Boolean),
      calculations: [],
      limitations: limitations,
      errors: errors,
      provenance: {
        provider: sourceId, model: null,
        promptVersion: def.promptVersion,
        tools: allowed.map(function (x) { return x.id; }),
        attempt: 1
      }
    });

    var checked = AR.validate(built, {
      taskId: result.taskId,
      stepId: result.stepId,
      agentId: agentId,
      agentIds: [agentId],
      evidenceIndex: Object.keys(evidenceIndex).length ? evidenceIndex : null,
      toolExecutions: calls.filter(function (c) { return !!c.executionId; })
    });
    if (!checked.ok) {
      checked.result.status = 'failed';
      checked.result.errors = checked.result.errors.concat(checked.errors);
      checked.result.limitations.push('成果契约校验未通过');
    }

    /* P2：成果同步到任务状态，UI 只读展示，不另建数据源。 */
    if (state) {
      if (!Array.isArray(state.agentResults)) state.agentResults = [];
      state.agentResults = state.agentResults.filter(function (x) {
        return x && x.stepId !== checked.result.stepId;
      }).concat([checked.result]);
    }

    if (T && state && T.appendEvent) {
      try {
        T.appendEvent(state, 'agent.result.created', {
          agentId: agentId,
          status: checked.result.status,
          toolCalls: calls.length,
          evidence: evidenceIds.length
        }, planStep && planStep.id);
      } catch (e2) { /* 事件记录失败不阻断 */ }
    }
    return checked.result;
  }

  /* 外部不可信内容：去掉控制字符，避免伪造 tool 角色块的文本注入。 */
  function sanitize(text) {
    return String(text == null ? '' : text)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .slice(0, TOOL_RESULT_CHARS);
  }

  root.AstroAgentExecutor = {
    version: VERSION,
    MAX_TURNS: MAX_TURNS,
    MAX_TOOL_CALLS: MAX_TOOL_CALLS,
    DEFS: DEFS,
    available: available,
    aliasOf: aliasOf,
    run: run
  };
})(typeof window !== 'undefined' ? window : globalThis);
