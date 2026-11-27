/* ASTRUM · V2 P0-B Agent 成果契约（AgentResult）
 *
 * 唯一职责：定义、归一化并校验单个 Agent 的执行成果。
 * 约束：
 *   - 不执行工具、不调用模型、不修改 Evidence。
 *   - 模型生成的 JSON 一律不可信：所有字段经本模块归一与校验。
 *   - 无真实执行记录的工具调用不得标记为成功。
 *   - 旧 StepResult / TaskState 不受影响（纯增量）。
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var STATUS = ['completed', 'partial', 'failed', 'timeout', 'cancelled', 'blocked'];
  var LEVELS = ['fact', 'inference', 'hypothesis'];

  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function clone(x) {
    if (x == null) return x;
    try { return JSON.parse(JSON.stringify(x)); } catch (e) { return x; }
  }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  function create(input) {
    input = input || {};
    var now = Date.now();
    var startedAt = typeof input.startedAt === 'number' ? input.startedAt : now;
    var completedAt = typeof input.completedAt === 'number' ? input.completedAt : now;
    var tools = arr(input.tools).slice();
    var prov = isObj(input.provenance) ? input.provenance : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      taskId: str(input.taskId),
      stepId: str(input.stepId),
      agentId: str(input.agentId),
      status: STATUS.indexOf(input.status) >= 0 ? input.status : 'completed',
      objective: str(input.objective),
      startedAt: startedAt,
      completedAt: completedAt,
      durationMs: typeof input.durationMs === 'number' ? input.durationMs : Math.max(0, completedAt - startedAt),
      actions: arr(input.actions).map(function (a) { return clone(a); }),
      toolCalls: arr(input.toolCalls).map(normalizeToolCall),
      findings: arr(input.findings).map(normalizeFinding),
      evidenceIds: arr(input.evidenceIds).filter(function (x) { return typeof x === 'string' && x; }),
      claims: arr(input.claims).map(function (c) { return clone(c); }),
      sources: arr(input.sources).map(function (s) { return clone(s); }),
      calculations: arr(input.calculations).map(function (c) { return clone(c); }),
      limitations: arr(input.limitations).map(function (x) { return String(x); }),
      errors: arr(input.errors).map(function (e) { return clone(e); }),
      provenance: {
        provider: prov.provider == null ? null : prov.provider,
        model: prov.model == null ? null : prov.model,
        promptVersion: prov.promptVersion == null ? null : prov.promptVersion,
        tools: Array.isArray(prov.tools) ? prov.tools.slice() : tools,
        attempt: typeof prov.attempt === 'number' ? prov.attempt : 1
      }
    };
  }

  function normalizeToolCall(tc) {
    tc = tc || {};
    var st = ['ok', 'failed', 'rejected', 'skipped'].indexOf(tc.status) >= 0 ? tc.status : 'failed';
    return {
      id: str(tc.id),
      name: str(tc.name),
      args: isObj(tc.args) ? clone(tc.args) : (isObj(tc.arguments) ? clone(tc.arguments) : {}),
      status: st,
      executionId: tc.executionId == null ? null : str(tc.executionId),
      evidenceIds: arr(tc.evidenceIds).filter(function (x) { return typeof x === 'string' && x; }),
      error: tc.error == null ? null : clone(tc.error)
    };
  }

  function normalizeFinding(f) {
    f = f || {};
    var level = LEVELS.indexOf(f.level) >= 0 ? f.level : 'inference';
    return {
      text: str(f.text || f.claim || ''),
      level: level,
      evidenceIds: arr(f.evidenceIds).filter(function (x) { return typeof x === 'string' && x; })
    };
  }

  function knownAgentIds(ctx) {
    if (ctx && Array.isArray(ctx.agentIds)) return ctx.agentIds.slice();
    var AC = root.AgentCore;
    if (AC && AC.AGENT_BY_ID) return Object.keys(AC.AGENT_BY_ID);
    return null;
  }

  function hasEvidence(index, id) {
    if (!index) return true;
    if (Array.isArray(index)) {
      for (var i = 0; i < index.length; i++) if (index[i] === id) return true;
      return false;
    }
    return Object.prototype.hasOwnProperty.call(index, id);
  }

  function hasExecution(execs, call) {
    if (!execs) return true;
    var list = Array.isArray(execs) ? execs : arr(execs.calls);
    for (var i = 0; i < list.length; i++) {
      var x = list[i] || {};
      if (call.executionId && x.executionId === call.executionId) return true;
      if (!call.executionId && x.toolId === call.name) return true;
    }
    return false;
  }

  /**
   * validate(result, ctx)
   * ctx: { taskId, stepId, agentId, agentIds, evidenceIndex, toolExecutions, strict }
   * 返回 { ok, errors, result }；result 为归一化后的副本（不修改入参）。
   */
  function validate(result, ctx) {
    ctx = ctx || {};
    /* 原始输入若带非法 status，必须显式报错；create() 的兜底不得掩盖模型脏输出。 */
    var rawStatus = result && result.status;
    var out = create(result);
    var errors = [];

    if (rawStatus != null && STATUS.indexOf(rawStatus) < 0) {
      errors.push({ code: 'E_STATUS_INVALID', message: '非法 status: ' + rawStatus });
    }
    if (!out.agentId) errors.push({ code: 'E_AGENT_MISSING', message: 'agentId 不能为空' });
    var known = knownAgentIds(ctx);
    if (out.agentId && known && known.indexOf(out.agentId) < 0) {
      errors.push({ code: 'E_AGENT_UNKNOWN', message: '未注册的 agentId: ' + out.agentId });
    }
    if (ctx.taskId && out.taskId !== ctx.taskId) {
      errors.push({ code: 'E_TASK_MISMATCH', message: 'taskId 与当前任务不一致' });
    }
    if (ctx.stepId && out.stepId !== ctx.stepId) {
      errors.push({ code: 'E_STEP_MISMATCH', message: 'stepId 与当前步骤不一致' });
    }
    if (ctx.agentId && out.agentId !== ctx.agentId) {
      errors.push({ code: 'E_AGENT_MISMATCH', message: 'agentId 与当前步骤不一致' });
    }
    if (STATUS.indexOf(out.status) < 0) {
      errors.push({ code: 'E_STATUS_INVALID', message: '非法 status: ' + out.status });
    }

    /* 证据必须真实存在；不存在的剔除并记录限制，而不是伪造。 */
    if (ctx.evidenceIndex) {
      var keptEv = [];
      out.evidenceIds.forEach(function (id) {
        if (hasEvidence(ctx.evidenceIndex, id)) keptEv.push(id);
        else out.limitations.push('证据 ' + id + ' 不在当前证据集中，已从成果中剔除');
      });
      out.evidenceIds = keptEv;
      out.findings.forEach(function (f) {
        var kept = f.evidenceIds.filter(function (id) { return hasEvidence(ctx.evidenceIndex, id); });
        if (kept.length !== f.evidenceIds.length) {
          out.limitations.push('部分 finding 引用的证据不存在，已剔除引用');
        }
        f.evidenceIds = kept;
      });
    }

    /* 工具调用必须有真实执行记录。 */
    out.toolCalls.forEach(function (c) {
      if (c.status !== 'ok') return;
      if (!ctx.toolExecutions) return;
      if (!hasExecution(ctx.toolExecutions, c)) {
        errors.push({
          code: 'E_TOOL_UNVERIFIED',
          message: '工具调用缺少真实执行记录: ' + (c.name || c.id)
        });
      }
    });

    /* findings 不得把无证据推断标成事实。 */
    out.findings.forEach(function (f) {
      if (f.level === 'fact' && !f.evidenceIds.length) {
        f.level = 'inference';
        out.limitations.push('无证据引用的 finding 已从 fact 降级为 inference');
      }
    });

    /* provenance 必须可区分模型与真实工具。 */
    if (!out.provenance.provider && !out.provenance.model && !out.provenance.promptVersion) {
      out.limitations.push('provenance 缺少 provider/model/promptVersion，来源不可区分');
    }

    return { ok: errors.length === 0, errors: errors, result: out };
  }

  /* 由真实 StepResult 构造（只读推导，不伪造） */
  function fromStepResult(step, meta) {
    step = step || {};
    meta = meta || {};
    var failure = !!(step.error && (step.status === 'failed' || step.status === 'blocked' || step.status === 'aborted'));
    return create({
      taskId: meta.taskId,
      stepId: step.id,
      agentId: meta.agentId || step.agentId || '',
      status: step.status === 'ok' ? 'completed' : (step.status === 'aborted' ? 'cancelled'
        : (step.status === 'blocked' ? 'blocked' : (failure ? 'failed' : 'partial'))),
      objective: meta.objective || step.desc || step.title || '',
      startedAt: step.startedAt ? Date.parse(step.startedAt) : undefined,
      completedAt: step.endedAt ? Date.parse(step.endedAt) : undefined,
      evidenceIds: arr(step.evidenceRefs),
      errors: step.error ? [step.error] : [],
      provenance: { provider: meta.provider || null, model: meta.model || null, promptVersion: meta.promptVersion || null, tools: meta.tools || [], attempt: step.attempt || 1 }
    });
  }

  function groupByAgent(list) {
    var map = {};
    arr(list).forEach(function (r) {
      if (!r || !r.agentId) return;
      if (!map[r.agentId]) {
        map[r.agentId] = { agentId: r.agentId, statuses: [], findings: [], evidenceIds: [], limitations: [], toolCalls: 0 };
      }
      var g = map[r.agentId];
      g.statuses.push(r.status);
      g.findings = g.findings.concat(arr(r.findings));
      g.evidenceIds = g.evidenceIds.concat(arr(r.evidenceIds));
      g.limitations = g.limitations.concat(arr(r.limitations));
      g.toolCalls += arr(r.toolCalls).length;
    });
    Object.keys(map).forEach(function (k) {
      var g = map[k];
      g.evidenceIds = g.evidenceIds.filter(function (v, i, a) { return a.indexOf(v) === i; });
      g.status = g.statuses.indexOf('failed') >= 0 ? 'failed'
        : (g.statuses.indexOf('partial') >= 0 ? 'partial' : 'completed');
      delete g.statuses;
    });
    return map;
  }

  root.AstroAgentResult = {
    version: '1.0.0',
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    LEVELS: LEVELS,
    create: create,
    validate: validate,
    fromStepResult: fromStepResult,
    groupByAgent: groupByAgent
  };
})(typeof window !== 'undefined' ? window : globalThis);
