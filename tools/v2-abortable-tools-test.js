/*
 * ASTRUM V2-B · R-01 / R-02 检索与合成工具可中断性测试
 *
 * 覆盖：
 *  - evidence.search / paper.search / llm.compose 声明 abortable
 *  - Sources.searchMany 的 signal 真正贯穿到 fetch
 *  - 预取消不发起请求；在飞取消中止底层 fetch 且不重试
 *  - 取消不计入端点熔断冷却
 *  - 暂停 / 用户取消语义经 registry 正确传递（pendingAbort + pause + abortCode）
 *  - paper 全文子链路收到 signal
 *  - compose 预取消不调用 adapter
 *
 * 用法：node tools/v2-abortable-tools-test.js
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '..');

/* sources.js 依赖 localStorage（有 try/catch 保护），这里提供内存实现。 */
global.localStorage = global.localStorage || {
  _d: {},
  getItem: function (k) { return this._d[k] == null ? null : this._d[k]; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; }
};

require(path.join(ROOT, 'core/sources.js'));
require(path.join(ROOT, 'core/registry.js'));

var S = global.Sources;
var R = global.AstroRegistry;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (extra == null ? '' : extra)); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function abortErr(msg) {
  var e = new Error(msg || 'The operation was aborted');
  e.name = 'AbortError';
  return e;
}
function specOf(id) {
  for (var i = 0; i < R.SPECS.length; i++) if (R.SPECS[i].id === id) return R.SPECS[i];
  return null;
}
function nonAbortableName(sig) { return sig && sig.aborted; }

(async function () {
  var unhandled = [];
  process.on('unhandledRejection', function (e) { unhandled.push(e); });

  /* ---------- 1. 工具声明 ---------- */
  var evSpec = specOf('evidence.search');
  var paperSpec = specOf('paper.search');
  var composeSpec = specOf('llm.compose');
  ok('V2-ABORTTOOL-01 检索/合成工具声明 abortable',
    evSpec && evSpec.abortable === true &&
    paperSpec && paperSpec.abortable === true &&
    composeSpec && composeSpec.abortable === true,
    JSON.stringify([evSpec && evSpec.abortable, paperSpec && paperSpec.abortable, composeSpec && composeSpec.abortable]));

  /* ---------- 2. 预取消：零网络请求 ---------- */
  var zeroCalls = 0;
  global.fetch = function () { zeroCalls++; return Promise.reject(abortErr()); };
  S.clearSearchCache();
  var ctl2 = new AbortController();
  ctl2.abort('pause');
  var err2 = null;
  try {
    await S.searchMany(['火星'], { types: ['paper'], maxCalls: 3, internal: true, signal: ctl2.signal });
  } catch (e) { err2 = e; }
  ok('V2-ABORTTOOL-02 预取消不发起任何请求并抛 cancelled',
    zeroCalls === 0 && err2 && err2.name === 'AbortError' && err2.cls && err2.cls.kind === 'cancelled',
    'calls=' + zeroCalls + ' err=' + (err2 && err2.name));

  /* ---------- 3/4/5. 在飞取消 ---------- */
  var counter = { calls: 0, signals: [] };
  global.fetch = function (url, opts) {
    counter.calls++;
    var sig = opts && opts.signal;
    counter.signals.push(sig);
    return new Promise(function (_, rej) {
      if (!sig) return;
      if (sig.aborted) { rej(abortErr()); return; }
      sig.addEventListener('abort', function () { rej(abortErr()); });
    });
  };
  S.clearSearchCache();
  var ctl3 = new AbortController();
  var p3 = S.searchMany(['火星'], { types: ['paper'], maxCalls: 3, internal: true, signal: ctl3.signal });
  await wait(30);
  ctl3.abort('pause');
  var err3 = null;
  try { await p3; } catch (e) { err3 = e; }
  var allAborted = counter.signals.length > 0 && counter.signals.every(function (s) { return s && s.aborted; });
  ok('V2-ABORTTOOL-03 在飞取消中止底层 fetch',
    counter.calls > 0 && allAborted && err3 && err3.name === 'AbortError',
    'calls=' + counter.calls + ' allAborted=' + allAborted + ' err=' + (err3 && err3.name));

  var callsAtAbort = counter.calls;
  await wait(600);
  ok('V2-ABORTTOOL-04 取消后不再发起新请求', counter.calls === callsAtAbort,
    'before=' + callsAtAbort + ' after=' + counter.calls);

  var cooling = (S.endpoints || []).filter(function (ep) {
    return S.healthOf(ep.id) && S.healthOf(ep.id).cooldownUntil > Date.now();
  });
  ok('V2-ABORTTOOL-05 取消不计入端点熔断冷却', cooling.length === 0,
    cooling.map(function (e) { return e.id; }).join(','));

  /* ---------- 6~8. evidence.search 的 signal 与语义 ---------- */
  R.createDefault().setRuntime ? null : null; /* 说明：默认注册表由 createDefault 创建 */
  var reg = R.createDefault();
  reg.setRuntime({ network: true });

  var realSearchMany = S.searchMany;
  var capturedOpts = null;
  S.searchMany = function (qs, opts) {
    capturedOpts = opts;
    return Promise.resolve({ items: [], errors: [], providers: [] });
  };
  var sig6 = new AbortController().signal;
  await evSpec.run({ query: '火星' }, {}, evSpec, {}, {}, { signal: sig6 });
  ok('V2-ABORTTOOL-06 evidence.search 透传 runtime.signal', capturedOpts && capturedOpts.signal === sig6,
    capturedOpts ? String(capturedOpts.signal === sig6) : 'no opts');

  /* 暂停：调用中 abort('pause')，应映射为 pendingAbort + pause */
  var ctl7 = new AbortController();
  S.searchMany = function (qs, opts) {
    return new Promise(function (_, rej) {
      if (opts.signal && opts.signal.addEventListener) {
        opts.signal.addEventListener('abort', function () { rej(abortErr()); });
      }
    });
  };
  var p7 = evSpec.run({ query: '火星' }, {}, evSpec, {}, {}, { signal: ctl7.signal });
  await wait(20);
  ctl7.abort('pause');
  var r7 = await p7;
  ok('V2-ABORTTOOL-07 暂停映射为 pendingAbort+pause+PAUSE_REQUESTED',
    r7 && r7.ok === false && r7.pendingAbort === true && r7.pause === true &&
    r7.kind === 'pause' && r7.abortCode === 'PAUSE_REQUESTED',
    JSON.stringify(r7));

  var ctl8 = new AbortController();
  var p8 = evSpec.run({ query: '火星' }, {}, evSpec, {}, {}, { signal: ctl8.signal });
  await wait(20);
  ctl8.abort('user');
  var r8 = await p8;
  ok('V2-ABORTTOOL-08 用户取消映射 USER_CANCELLED 且非 pause',
    r8 && r8.pendingAbort === true && r8.pause === false &&
    r8.kind === 'cancelled' && r8.abortCode === 'USER_CANCELLED',
    JSON.stringify(r8));

  /* ---------- 9/10. paper.search ---------- */
  var paperCalls = 0;
  S.searchMany = function () { paperCalls++; return Promise.resolve({ items: [], errors: [], providers: [] }); };
  var ctl9 = new AbortController();
  ctl9.abort('pause');
  var r9 = await paperSpec.run({ query: '火星', fulltext: true }, {}, paperSpec, {}, {}, { signal: ctl9.signal });
  ok('V2-ABORTTOOL-09 paper.search 预取消不检索',
    paperCalls === 0 && r9 && r9.pendingAbort === true && r9.pause === true,
    'calls=' + paperCalls + ' r=' + JSON.stringify(r9));

  global.AstroEvidence = {
    fromSourceItem: function (it) { return { evidenceId: 'ev-' + (it && it.id || 'x'), title: (it && it.title) || '' }; }
  };
  var ftSignal = null;
  global.AstroPaperFulltext = {
    get: function (item, opts) {
      ftSignal = opts && opts.signal;
      return Promise.resolve({ ok: true, paperId: 'p1', url: 'https://example.org/p1', evidence: [], chunks: [], parse: {} });
    }
  };
  S.searchMany = function () {
    return Promise.resolve({
      items: [{ id: 'p1', title: 'Mars paper', type: 'paper' }],
      errors: [], providers: [{ id: 'openalex', ok: true }]
    });
  };
  var sig10 = new AbortController().signal;
  var r10 = await paperSpec.run({ query: '火星', fulltext: true, fulltextItems: 1 }, {}, paperSpec, {}, {}, { signal: sig10 });
  ok('V2-ABORTTOOL-10 paper.search 全文链路收到 signal',
    r10 && r10.ok === true && ftSignal === sig10 && (r10.fulltexts || []).length === 1,
    'ftSignal=' + String(ftSignal === sig10) + ' fulltexts=' + ((r10 && r10.fulltexts) || []).length);

  /* ---------- 11/12. llm.compose ---------- */
  var composeCalled = 0;
  reg.setRuntime({
    network: true,
    adapter: { compose: function () { composeCalled++; return { ok: true, answer: 'ok' }; } }
  });

  var ctl11 = new AbortController();
  ctl11.abort('pause');
  var r11 = await composeSpec.run({ query: '火星' }, {}, composeSpec, {}, {}, { signal: ctl11.signal });
  ok('V2-ABORTTOOL-11 llm.compose 预取消不调用 adapter',
    composeCalled === 0 && r11 && r11.pendingAbort === true && r11.pause === true,
    'called=' + composeCalled + ' r=' + JSON.stringify(r11));

  var r12 = await composeSpec.run({ query: '火星' }, {}, composeSpec, {}, {}, { signal: new AbortController().signal });
  ok('V2-ABORTTOOL-12 llm.compose 正常路径不受影响',
    composeCalled === 1 && r12 && r12.ok === true && r12.answer === 'ok',
    'called=' + composeCalled + ' r=' + JSON.stringify(r12));

  /* 恢复真实实现，避免影响同进程后续断言 */
  S.searchMany = realSearchMany;

  await wait(50);
  ok('V2-ABORTTOOL-13 无未处理 Promise rejection', unhandled.length === 0,
    unhandled.map(function (e) { return e && e.message; }).join(' | '));

  console.log('\nRESULT ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
