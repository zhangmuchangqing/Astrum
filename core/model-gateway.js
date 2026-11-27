/* ASTRUM · V2 P0-A 模型调用治理层（ModelGateway）
 *
 * 职责边界（不得越界）：
 *   1) 只做模型调用治理：预算、并发、重试、取消、错误归一、usage 归一。
 *   2) 不实现供应商协议 —— 请求构造与响应解析仍在 core/sources.js。
 *   3) 不执行工具、不解析业务、不写业务状态（只通过 AstroTask 预算记账）。
 *
 * 约束：
 *   - 首版不支持流式工具调用（capabilities().streamingTools === false），
 *     Agent 工具循环必须使用非流式 generate()，不得伪造流式工具支持。
 *   - 旧调用方（control-bridge / app.js）不经过本模块，行为完全不变。
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_CONCURRENCY = 4;
  var DEFAULT_TIMEOUT_MS = 60000;
  var MAX_RETRIES = 2;

  var active = 0;
  var waiters = [];
  var stats = { calls: 0, retries: 0, failures: 0, aborted: 0, budgetDenied: 0, maxActive: 0, cacheHits: 0, dedupes: 0, tiered: 0 };

  /* ---------------- P0-E：缓存 / 去重 / 模型分级 / 成本 ---------------- */

  var CACHE_TTL = 5 * 60 * 1000;
  var CACHE_MAX = 50;
  var cache = {};
  var cacheOrder = [];
  var inflight = {};

  function sha(text) {
    var T = root.AstroTask;
    return T && T.sha256Hex ? T.sha256Hex(text) : ('k' + text.length + ':' + text.slice(0, 120));
  }

  function cacheKey(opts, model) {
    return sha(JSON.stringify({
      s: opts.sourceId || '',
      m: model || '',
      q: opts.messages || [],
      t: opts.tools || null,
      tp: opts.temperature == null ? null : opts.temperature,
      mt: opts.maxTokens == null ? null : opts.maxTokens
    }));
  }

  function cloneResult(r) {
    try { return JSON.parse(JSON.stringify(r)); } catch (e) { return r; }
  }

  function cacheGet(key) {
    var hit = cache[key];
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) { cacheDel(key); return null; }
    return cloneResult(hit.value);
  }

  function cacheSet(key, value) {
    cache[key] = { at: Date.now(), value: cloneResult(value) };
    cacheOrder.push(key);
    while (cacheOrder.length > CACHE_MAX) {
      var k = cacheOrder.shift();
      delete cache[k];
    }
  }

  function cacheDel(key) {
    delete cache[key];
    var i = cacheOrder.indexOf(key);
    if (i >= 0) cacheOrder.splice(i, 1);
  }

  function clearCache() { cache = {}; cacheOrder = []; }

  /* 档位：L1 → fast，L2 → standard，L3/L4 → deep。无映射时不覆盖来源模型。 */
  function tierForLevel(level) {
    var lv = level;
    if (lv === 4 || lv === '4') lv = 'L4';
    else if (lv === 3 || lv === '3') lv = 'L3';
    else if (lv === 2 || lv === '2') lv = 'L2';
    else if (lv === 1 || lv === '1') lv = 'L1';
    if (lv === 'L3' || lv === 'L4') return 'deep';
    if (lv === 'L2') return 'standard';
    return 'fast';
  }

  function tierMapping() {
    try {
      if (typeof localStorage === 'undefined') return {};
      var raw = localStorage.getItem('astrum.modelTiers');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function setTierMapping(sourceId, map) {
    try {
      var all = tierMapping();
      if (map == null) delete all[sourceId];
      else all[sourceId] = map;
      localStorage.setItem('astrum.modelTiers', JSON.stringify(all));
      return all;
    } catch (e) { return null; }
  }

  function resolveModel(opts) {
    if (opts.model) return { model: String(opts.model), tier: 'explicit' };
    var map = tierMapping()[opts.sourceId || ''];
    if (!map) return { model: null, tier: null };
    var level = opts.taskLevel ||
      (opts.state && (opts.state.level || (opts.state.budget && opts.state.budget.level))) || 'L1';
    var tier = tierForLevel(level);
    return { model: map[tier] || map.standard || null, tier: tier };
  }

  function accumulateCost(state, usage, meta) {
    if (!state) return;
    if (root.AstroTask && typeof root.AstroTask.addCost === 'function') {
      try { root.AstroTask.addCost(state, usage, meta); return; } catch (e) { /* fallback */ }
    }
    var c = state.cost || {
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      calls: 0, estimatedCost: null, currency: null
    };
    c.calls = (c.calls || 0) + 1;
    c.promptTokens = (c.promptTokens || 0) + ((usage && usage.promptTokens) || 0);
    c.completionTokens = (c.completionTokens || 0) + ((usage && usage.completionTokens) || 0);
    c.totalTokens = (c.totalTokens || 0) + ((usage && usage.totalTokens) || 0);
    state.cost = c;
  }


  /* ---------------- 错误分类 ---------------- */

  var KIND_TO_CODE = {
    auth: 'AUTH_ERROR',
    rate_limit: 'RATE_LIMITED',
    timeout: 'TIMEOUT',
    network: 'NETWORK_ERROR',
    cors: 'NETWORK_ERROR',
    csp: 'NETWORK_ERROR',
    server: 'PROVIDER_ERROR',
    notfound: 'INVALID_REQUEST',
    parse: 'INVALID_RESPONSE',
    stream: 'PROVIDER_ERROR',
    empty: 'INVALID_RESPONSE',
    unknown: 'UNKNOWN'
  };
  var RETRIABLE_CODES = { NETWORK_ERROR: true, TIMEOUT: true, RATE_LIMITED: true, PROVIDER_ERROR: true };

  function classifyError(e) {
    var cls = null;
    if (root.Sources && typeof root.Sources.classifyError === 'function') {
      try { cls = root.Sources.classifyError(e); } catch (x) { cls = null; }
    }
    var kind = (cls && cls.kind) || (e && e.cls && e.cls.kind) || 'unknown';
    var code = KIND_TO_CODE[kind] || 'UNKNOWN';
    return {
      code: code,
      kind: kind,
      message: (e && e.message) || (cls && cls.msg) || String(e || '未知错误'),
      status: (e && e.status) || (cls && cls.status) || null,
      retryAfter: (e && e.retryAfter != null) ? e.retryAfter : (cls && cls.retryAfter != null ? cls.retryAfter : null),
      retriable: RETRIABLE_CODES[code] === true
    };
  }

  function failure(code, message, extra) {
    var e = {
      code: code, kind: code, message: String(message || code),
      status: null, retryAfter: null, retriable: RETRIABLE_CODES[code] === true, raw: ''
    };
    Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
    return {
      status: code === 'ABORTED' ? 'aborted' : 'failed',
      text: '', toolCalls: [], finishReason: '',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      provider: (extra && extra.provider) || '', model: (extra && extra.model) || '',
      requestId: null, error: e, raw: null
    };
  }

  /* ---------------- 配置与能力 ---------------- */

  function sourceMeta(id) {
    if (!root.Sources || typeof root.Sources.list !== 'function') return null;
    var list = [];
    try { list = root.Sources.list() || []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function capabilities(id) {
    var meta = sourceMeta(id);
    if (!meta) return { exists: false, tools: false, streamingTools: false, stream: false, shape: null };
    var shape = meta.shape || 'openai';
    var cloud = meta.type === 'cloud';
    return {
      exists: true,
      cloud: cloud,
      shape: shape,
      tools: cloud && (shape === 'openai' || shape === 'anthropic' || shape === 'gemini'),
      /* 首版明确不支持流式工具调用（参数分片未闭合前不得执行）。 */
      streamingTools: false,
      stream: cloud && (shape === 'openai' || shape === 'anthropic' || shape === 'gemini')
    };
  }

  function getModelConfig(opts) {
    opts = opts || {};
    var id = opts.sourceId || opts.id || '';
    var meta = sourceMeta(id);
    var conf = null;
    if (root.Sources && typeof root.Sources.conf === 'function') {
      try { conf = root.Sources.conf(id); } catch (e) { conf = null; }
    }
    return {
      sourceId: id,
      exists: !!meta,
      shape: meta ? (meta.shape || 'openai') : null,
      provider: id,
      model: conf ? conf.model : null,
      endpoint: conf ? conf.endpoint : null,
      temperature: opts.temperature != null ? opts.temperature : (conf ? conf.temperature : null),
      maxTokens: opts.maxTokens != null ? opts.maxTokens : (conf ? conf.maxTokens : null),
      hasKey: !!(conf && conf.key)
    };
  }

  /* ---------------- usage 归一 ---------------- */

  function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') {
      return { promptTokens: null, completionTokens: null, totalTokens: null };
    }
    var p = numOrNull(raw.promptTokens != null ? raw.promptTokens : raw.prompt);
    var c = numOrNull(raw.completionTokens != null ? raw.completionTokens : raw.completion);
    var t = numOrNull(raw.totalTokens != null ? raw.totalTokens : raw.total);
    if (t == null && (p != null || c != null)) t = (p || 0) + (c || 0);
    return { promptTokens: p, completionTokens: c, totalTokens: t };
  }

  /* ---------------- 并发闸门 ---------------- */

  function acquire(signal) {
    if (signal && signal.aborted) return Promise.resolve(null);
    if (active < MAX_CONCURRENCY) {
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      return Promise.resolve(releaseFn());
    }
    return new Promise(function (resolve) {
      var entry = { resolve: resolve, signal: signal, onAbort: null };
      if (signal && signal.addEventListener) {
        entry.onAbort = function () {
          var i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        };
        signal.addEventListener('abort', entry.onAbort);
      }
      waiters.push(entry);
    });
  }

  function releaseFn() {
    var done = false;
    return function () {
      if (done) return;
      done = true;
      var next = waiters.shift();
      if (next) {
        if (next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        stats.maxActive = Math.max(stats.maxActive, active);
        next.resolve(releaseFn());
      } else {
        active = Math.max(0, active - 1);
      }
    };
  }

  function delay(ms, signal) {
    return new Promise(function (resolve) {
      var t = setTimeout(finish, Math.max(0, ms));
      function finish() {
        clearTimeout(t);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() { finish(); }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
    });
  }

  /* ---------------- 预算（复用 AstroTask，不新建体系） ---------------- */

  function canSpend(state, delta) {
    var T = root.AstroTask;
    if (!state || !T || typeof T.canAfford !== 'function') return { allowed: true };
    try { return { allowed: !!T.canAfford(state.budget, delta) }; }
    catch (e) { return { allowed: true }; }
  }

  function spend(state, delta) {
    var T = root.AstroTask;
    if (!state || !T || typeof T.spend !== 'function') return;
    try { T.spend(state.budget, delta); } catch (e) { /* 记账失败不影响结果 */ }
  }

  /* ---------------- generate（非流式，唯一 Agent 路径） ---------------- */

  /**
   * opts: {
   *   sourceId, agentId, messages, tools, signal, timeoutMs, maxRetries,
   *   temperature, maxTokens, state, taskId, stepId, question
   * }
   */
  function generate(opts) {
    opts = opts || {};
    var id = opts.sourceId || '';
    var signal = opts.signal || null;
    var caps = capabilities(id);
    var cfg = getModelConfig({ sourceId: id, temperature: opts.temperature, maxTokens: opts.maxTokens });

    if (!caps.exists) return Promise.resolve(failure('INVALID_REQUEST', '模型来源不存在', { provider: id }));
    if (opts.tools && opts.tools.length && !caps.tools) {
      return Promise.resolve(failure('INVALID_REQUEST', '该来源不支持工具调用', { provider: id, model: cfg.model }));
    }
    if (!opts.messages || !opts.messages.length) {
      return Promise.resolve(failure('INVALID_REQUEST', '缺少 messages', { provider: id, model: cfg.model }));
    }
    if (signal && signal.aborted) {
      stats.aborted += 1;
      return Promise.resolve(failure('ABORTED', '已取消', { provider: id, model: cfg.model }));
    }

    var budget = canSpend(opts.state, { llmCalls: 1 });
    if (!budget.allowed) {
      stats.budgetDenied += 1;
      return Promise.resolve(failure('BUDGET_EXCEEDED', '任务模型调用预算已耗尽', { provider: id, model: cfg.model }));
    }

    var maxRetries = typeof opts.maxRetries === 'number' ? Math.max(0, Math.min(MAX_RETRIES, opts.maxRetries)) : 0;
    var attempt = 0;
    var resolved = resolveModel(opts);
    var useCache = opts.cache !== false;
    var key = useCache ? cacheKey(opts, resolved.model) : null;

    if (key) {
      var hit = cacheGet(key);
      if (hit) { stats.cacheHits += 1; hit.cacheHit = true; return Promise.resolve(hit); }
      if (inflight[key]) {
        stats.dedupes += 1;
        return inflight[key].then(function (r) {
          var copy = cloneResult(r);
          copy.dedupeHit = true;
          return copy;
        });
      }
    }

    function once() {
      if (signal && signal.aborted) {
        stats.aborted += 1;
        return Promise.resolve(failure('ABORTED', '已取消', { provider: id, model: cfg.model }));
      }
      return acquire(signal).then(function (release) {
        if (!release) return failure('ABORTED', '已取消', { provider: id, model: cfg.model });
        var payload = {
          messages: opts.messages,
          tools: opts.tools || null,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
          signal: signal,
          question: opts.question || '',
          agentId: opts.agentId || '',
          model: resolved.model || null
        };
        stats.calls += 1;
        return Promise.resolve(root.Sources.generateRaw(id, payload)).then(function (r) {
          return r;
        }, function (e) {
          var cls = classifyError(e);
          return failure(cls.code, cls.message, {
            provider: id, model: cfg.model, status: cls.status, retryAfter: cls.retryAfter, retriable: cls.retriable
          });
        }).then(function (r) {
          release();
          spend(opts.state, { llmCalls: 1, tokens: (r && r.usage && r.usage.totalTokens) || 0 });
          if (r && r.status === 'failed') stats.failures += 1;
          if (r && resolved.model) {
            r.model = resolved.model;
            r.modelTier = resolved.tier;
            if (resolved.tier !== 'explicit') stats.tiered += 1;
          }
          if (r && r.status === 'completed') {
            accumulateCost(opts.state, r.usage, {
              provider: id, model: r.model || cfg.model, tier: resolved.tier || null
            });
          }
          return r;
        });
      });
    }

    function loop() {
      if (signal && signal.aborted) return Promise.resolve(failure('ABORTED', '已取消', { provider: id, model: cfg.model }));
      attempt += 1;
      return once().then(function (r) {
        var err = r && r.error;
        var canRetry = err && err.retriable && attempt <= maxRetries &&
          !(signal && signal.aborted);
        if (!canRetry) return r;
        stats.retries += 1;
        var wait = err.retryAfter != null ? Math.max(0, Number(err.retryAfter) || 0) * 1000
          : Math.min(4000, 300 * Math.pow(2, attempt - 1));
        return delay(wait, signal).then(loop);
      });
    }

    var promise = loop().then(function (r) {
      if (r && r.status === 'failed' && !r.error) {
        r.error = { code: 'UNKNOWN', kind: 'unknown', message: '未知失败', status: null, retryAfter: null, retriable: false, raw: '' };
      }
      if (r) r.usage = normalizeUsage(r.usage);
      return r;
    });

    if (key) {
      inflight[key] = promise;
      promise.then(function (r) {
        delete inflight[key];
        if (r && r.status === 'completed') cacheSet(key, r);
      }, function () { delete inflight[key]; });
    }
    return promise;
  }

  /* ---------------- stream（沿用旧流式行为，不改契约） ---------------- */

  function stream(opts) {
    opts = opts || {};
    var id = opts.sourceId || '';
    var handlers = opts.handlers || {};
    var caps = capabilities(id);
    if (!caps.exists) return Promise.resolve(failure('INVALID_REQUEST', '模型来源不存在', { provider: id }));
    if (!caps.stream) {
      return Promise.resolve({
        status: 'failed', text: '', toolCalls: [], finishReason: '',
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        provider: id, model: getModelConfig({ sourceId: id }).model,
        requestId: null, raw: null,
        error: { code: 'INVALID_REQUEST', kind: 'INVALID_REQUEST', message: '该来源不支持流式输出', retriable: false }
      });
    }
    var payload = Object.assign({}, opts.payload || {});
    payload.signal = opts.signal || payload.signal;
    if (opts.timeoutMs) payload.timeoutMs = opts.timeoutMs;
    if (opts.firstTokenMs) payload.firstTokenMs = opts.firstTokenMs;
    return Promise.resolve(root.Sources.streamChat(id, payload, handlers)).then(function (r) {
      return {
        status: r && r.aborted ? 'aborted' : 'completed',
        text: (r && r.text) || '',
        toolCalls: [],
        finishReason: (r && r.aborted) ? 'aborted' : 'stop',
        usage: normalizeUsage(r && r.usage),
        provider: id,
        model: getModelConfig({ sourceId: id }).model,
        requestId: null,
        raw: r || null,
        aborted: !!(r && r.aborted),
        stream: !(r && r.fallback),
        fallback: !!(r && r.fallback),
        error: null
      };
    }, function (e) {
      var cls = classifyError(e);
      var f = failure(cls.code, cls.message, { provider: id, model: getModelConfig({ sourceId: id }).model, status: cls.status, retryAfter: cls.retryAfter, retriable: cls.retriable });
      f.text = (e && e.text) || '';
      f.partial = !!(e && e.partial);
      return f;
    });
  }

  function resetStats() {
    stats = { calls: 0, retries: 0, failures: 0, aborted: 0, budgetDenied: 0, maxActive: 0, cacheHits: 0, dedupes: 0, tiered: 0 };
  }

  root.AstroModelGateway = {
    version: VERSION,
    MAX_CONCURRENCY: MAX_CONCURRENCY,
    capabilities: capabilities,
    getModelConfig: getModelConfig,
    classifyError: classifyError,
    normalizeUsage: normalizeUsage,
    generate: generate,
    stream: stream,
    clearCache: clearCache,
    cacheSize: function () { return cacheOrder.length; },
    setTierMapping: setTierMapping,
    tierMapping: tierMapping,
    tierForLevel: tierForLevel,
    resolveModel: resolveModel,
    stats: function () { return JSON.parse(JSON.stringify(stats)); },
    resetStats: resetStats
  };
})(typeof window !== 'undefined' ? window : globalThis);
