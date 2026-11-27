/* ASTRUM V2-B · R-08 暂停请求超时收尾（运行页失联后的接管）测试
 *
 * 背景：pause() 由请求方写 pauseRequestedAt，权威 PAUSED 由运行页在安全边界确认。
 * 若运行页在确认前崩溃/关闭，请求会永久悬空。本测试验证 reconcilePauseRequest 的接管条件：
 *   - 未到时限 / 请求后仍有进展 / 本页有活跃运行 → 一律不接管（noop）
 *   - 已到时限且无进展 → CAS 收尾：在飞步骤回队、写 pausedAt、记事件与检查点
 *   - 冲突（STALE_WRITE）→ 返回 contended，回滚内存态，绝不伪造 PAUSED
 *   - 运行页仍存活但落后一个修订时，吸收 pausedAt 而不是覆盖回运行态
 *
 * 用法：node tools/v2-pause-timeout-reconcile-test.js
 */
'use strict';
var path = require('path');
var fs = require('fs');
var vm = require('vm');
var ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'core/task.js'));
require(path.join(ROOT, 'core/dag-validator.js'));
require(path.join(ROOT, 'core/orchestrator.js'));

var T = global.AstroTask;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (extra == null ? '' : extra)); }
}
function waitFor(fn, ms) {
  var t0 = Date.now();
  return new Promise(function (res) {
    (function c() {
      if (fn()) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(c, 25);
    })();
  });
}
function isoAgo(ms) { return new Date(Date.now() - ms).toISOString(); }

/* 共享内存 store：revision 递增 + expectedRevision 校验（与跨标签页测试同一实现）。 */
function sharedStore() {
  var recs = {};
  return {
    ownerProfileId: function () { return null; },
    get: async function (id) { return recs[id] ? T.fromJSON(recs[id].state) : null; },
    getRecord: async function (id) { return recs[id] || null; },
    isResumable: function () { return true; },
    get recs() { return recs; },
    save: async function (state, sopts) {
      var prev = recs[state.id];
      if (sopts && sopts.expectedRevision != null) {
        var cur = prev ? prev.revision : 0;
        if (cur !== sopts.expectedRevision) { var e = new Error('stale'); e.code = 'STALE_WRITE'; throw e; }
      }
      recs[state.id] = {
        id: state.id, ownerProfileId: null, projectId: null,
        revision: (prev ? prev.revision : 0) + 1,
        updatedAt: new Date().toISOString(), state: T.toJSON(state)
      };
      return state.id;
    },
    raw: function (id) { return recs[id]; }
  };
}

function loadControl(windowObj, BCctor, deps) {
  var sandbox = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
    Error: Error, Promise: Promise, AbortController: AbortController,
    BroadcastChannel: BCctor || undefined
  };
  windowObj.AstroTask = T;
  windowObj.AstroOrchestrator = global.AstroOrchestrator;
  windowObj.AgentCore = deps.AC;
  windowObj.AstroRouter = deps.Router;
  windowObj.AstroPlanner = deps.Planner;
  windowObj.AstroRegistry = undefined;
  sandbox.window = windowObj;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  var src = fs.readFileSync(path.join(ROOT, 'core/control.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'control.js' });
  return windowObj;
}

/* 构造一条「暂停请求已发出但运行页未确认」的任务。 */
function seed(store, opts) {
  opts = opts || {};
  var st = T.create({ question: 'q', level: 'L3' });
  st.plan = { planId: 'p', version: 1, steps: [{ id: 's1', tool: 'slow', deps: [], args: {} }] };
  st.steps = st.plan.steps.map(function (ps) { return T.makeStep(ps); });
  var step = st.steps[0];
  step.status = 'running';
  step.startedAt = isoAgo(opts.stepAgeMs == null ? 120000 : opts.stepAgeMs);
  if (opts.noRequest) {
    st.pauseRequestedAt = null;
  } else {
    st.pauseRequestedAt = isoAgo(opts.reqAgeMs == null ? 60000 : opts.reqAgeMs);
    T.appendEvent(st, 'task.pause_requested', { reason: 'user' });
    st.events[st.events.length - 1].at = st.pauseRequestedAt;
  }
  if (opts.paused) st.pausedAt = isoAgo(30000);
  return store.save(st).then(function () { return st.id; });
}

(async function () {
  var deps = {
    AC: { resolveTargets: function () { return []; }, detectIntent: function () { return 'research'; } },
    Router: { route: function () { return { mode: 'research', level: 'L3', legacy: false, targets: [] }; } },
    Planner: { plan: function () { return { planId: 'p', version: 1, steps: [{ id: 's1', tool: 'slow', deps: [], args: {} }] }; } }
  };

  /* C 页：另一个标签页，只做收尾，不跑任务。 */
  var C = loadControl({}, undefined, deps);
  var R = C.AstroControl.reconcilePauseRequest;

  /* V2-R08T-01/02：无请求 / 已暂停 → 不动 */
  var s1 = sharedStore();
  var id1 = await seed(s1, { noRequest: true });
  var r1 = await R(id1, { store: s1 });
  ok('V2-R08T-01 无暂停请求时 noop', r1.action === 'noop' && r1.reason === 'not_requested', JSON.stringify(r1.reason));
  var s2 = sharedStore();
  var id2 = await seed(s2, { paused: true });
  var r2 = await R(id2, { store: s2 });
  ok('V2-R08T-02 已暂停时 noop 且修订不变',
    r2.action === 'noop' && r2.reason === 'already_paused' && s2.raw(id2).revision === 1,
    JSON.stringify({ reason: r2.reason, rev: s2.raw(id2).revision }));

  /* V2-R08T-03：未到时限不接管 */
  var s3 = sharedStore();
  var id3 = await seed(s3, { reqAgeMs: 5000 });
  var r3 = await R(id3, { store: s3, timeoutMs: 30000 });
  ok('V2-R08T-03 未到时限 noop 且给出剩余等待时间',
    r3.action === 'noop' && r3.reason === 'within_grace' && r3.waitMs > 0 && s3.raw(id3).revision === 1,
    JSON.stringify({ reason: r3.reason, waitMs: r3.waitMs, rev: s3.raw(id3).revision }));

  /* V2-R08T-04：请求后仍有进展（步骤在请求之后才启动）→ 视为运行页存活 */
  var s4 = sharedStore();
  var id4 = await seed(s4, { reqAgeMs: 60000, stepAgeMs: 10000 });
  var r4 = await R(id4, { store: s4 });
  ok('V2-R08T-04 请求后仍有进展时 noop（不与存活运行页竞争）',
    r4.action === 'noop' && r4.reason === 'recent_activity' && s4.raw(id4).revision === 1,
    JSON.stringify({ reason: r4.reason }));

  /* V2-R08T-05~08：超时且无进展 → 接管收尾 */
  var s5 = sharedStore();
  var id5 = await seed(s5, { reqAgeMs: 60000, stepAgeMs: 120000 });
  var r5 = await R(id5, { store: s5 });
  ok('V2-R08T-05 超时且无进展时接管为 PAUSED',
    r5.action === 'finalized' && r5.paused === true && r5.verdict === 'PAUSED' && r5.reclaimedSteps === 1,
    JSON.stringify({ action: r5.action, reclaimed: r5.reclaimedSteps }));
  var persisted5 = T.fromJSON(s5.raw(id5).state);
  ok('V2-R08T-06 落盘 pausedAt、清空 pauseRequestedAt、修订 +1',
    !!persisted5.pausedAt && !persisted5.pauseRequestedAt && s5.raw(id5).revision === 2,
    JSON.stringify({ pausedAt: persisted5.pausedAt, req: persisted5.pauseRequestedAt, rev: s5.raw(id5).revision }));
  var step5 = persisted5.steps[0];
  ok('V2-R08T-07 在飞步骤回队为 pending 并带 PAUSE_REQUESTED 中止标记',
    step5.status === 'pending' && !step5.startedAt && step5.abort && step5.abort.code === 'PAUSE_REQUESTED',
    JSON.stringify({ status: step5.status, abort: step5.abort }));
  var evs5 = persisted5.events.map(function (e) { return e.type + ':' + ((e.payload && e.payload.reason) || ''); });
  ok('V2-R08T-08 事件链含 step.paused(stale_run) 与 task.paused(pause_timeout)',
    evs5.indexOf('step.paused:stale_run') >= 0 && evs5.indexOf('task.paused:pause_timeout') >= 0,
    JSON.stringify(evs5));
  ok('V2-R08T-08b 收尾生成检查点', Array.isArray(persisted5.checkpoints) && persisted5.checkpoints.length >= 1,
    String(persisted5.checkpoints && persisted5.checkpoints.length));

  var r5b = await R(id5, { store: s5 });
  ok('V2-R08T-09 重复收尾幂等（already_paused，不再写盘）',
    r5b.action === 'noop' && r5b.reason === 'already_paused' && s5.raw(id5).revision === 2,
    JSON.stringify({ reason: r5b.reason, rev: s5.raw(id5).revision }));

  var r6 = await R('missing-task', { store: s5 });
  ok('V2-R08T-10 任务不存在时 noop（不抛错）', r6.action === 'noop' && r6.reason === 'not_found', JSON.stringify(r6.reason));

  /* V2-R08T-11/12：并发冲突 → contended + 回滚，不伪造 PAUSED */
  var s7 = sharedStore();
  var id7 = await seed(s7, { reqAgeMs: 60000, stepAgeMs: 120000 });
  var realSave = s7.save;
  var injected = false;
  s7.save = async function (state, sopts) {
    if (!injected && sopts && sopts.expectedRevision != null) {
      injected = true;
      var e = new Error('stale'); e.code = 'STALE_WRITE'; throw e;
    }
    return realSave.call(s7, state, sopts);
  };
  var r7 = await R(id7, { store: s7 });
  var stored7 = T.fromJSON(s7.raw(id7).state);
  ok('V2-R08T-11 CAS 冲突返回 contended 而非 finalized',
    r7.action === 'contended' && r7.reason === 'STALE_WRITE',
    JSON.stringify({ action: r7.action, reason: r7.reason }));
  ok('V2-R08T-12 冲突后落盘状态未被伪造为 PAUSED，步骤回到 running',
    !stored7.pausedAt && stored7.pauseRequestedAt && stored7.steps[0].status === 'running',
    JSON.stringify({ pausedAt: stored7.pausedAt, req: stored7.pauseRequestedAt, status: stored7.steps[0].status }));

  /* V2-R08T-13/14：pause() 在超时后由本页直接接管 */
  var s8 = sharedStore();
  var id8 = await seed(s8, { reqAgeMs: 60000, stepAgeMs: 120000 });
  var p8 = await C.AstroControl.pause(id8, { store: s8 });
  var stored8 = T.fromJSON(s8.raw(id8).state);
  ok('V2-R08T-13 再次 pause 时超时请求被本页接管为 PAUSED',
    p8 && p8.verdict === 'PAUSED' && p8.already === true && p8.reclaimed === 1,
    JSON.stringify({ verdict: p8 && p8.verdict, reclaimed: p8 && p8.reclaimed }));
  ok('V2-R08T-14 接管后的落盘状态为已暂停', !!stored8.pausedAt && !stored8.pauseRequestedAt,
    JSON.stringify({ pausedAt: stored8.pausedAt }));

  var s9 = sharedStore();
  var id9 = await seed(s9, { reqAgeMs: 5000 });
  var p9 = await C.AstroControl.pause(id9, { store: s9 });
  ok('V2-R08T-15 未超时的 pause 仍只返回 PAUSE_REQUESTED 并给出 waitMs',
    p9 && p9.verdict === 'PAUSE_REQUESTED' && p9.waitMs > 0 && s9.raw(id9).revision === 1,
    JSON.stringify({ verdict: p9 && p9.verdict, waitMs: p9 && p9.waitMs }));

  /* --- 场景：运行页 A 仍存活（落后修订），C 页超时收尾，A 不得覆盖回运行态 --- */
  var A = loadControl({}, undefined, deps);
  var s10 = sharedStore();
  var gate = null;
  var registry = {
    list: function () { return ['slow']; },
    get: function () {
      return {
        id: 'slow', version: '1', timeoutMs: 60000, idempotent: true, sideEffect: false, abortable: true,
        run: function () {
          return new Promise(function (resolve) { gate = resolve; });
        }
      };
    }
  };
  var taskId = null;
  var runAp = A.AstroControl.run('timeout reconcile live', {}, {}, {
    store: s10, registry: registry,
    routeData: { targets: [], intent: 'research', route: { mode: 'research', level: 'L3', legacy: false, targets: [] } },
    onTask: function (id) { taskId = id; }
  });
  await waitFor(function () { return !!taskId && !!(s10.raw(taskId) && gate); }, 3000);
  var rec10 = s10.raw(taskId);
  var live = T.fromJSON(rec10.state);
  /* 模拟「运行页已崩溃」：所有历史事件与步骤时间都早于暂停请求。 */
  (live.events || []).forEach(function (e) { e.at = isoAgo(120000); });
  live.steps[0].startedAt = isoAgo(120000);
  live.steps[0].status = 'running';
  live.pauseRequestedAt = isoAgo(60000);
  T.appendEvent(live, 'task.pause_requested', { reason: 'user' });
  live.events[live.events.length - 1].at = live.pauseRequestedAt;
  rec10.state = T.toJSON(live);

  var selfReconcile = await A.AstroControl.reconcilePauseRequest(taskId, { store: s10 });
  ok('V2-R08T-16 本页有活跃运行时拒绝接管（run_active_here）',
    selfReconcile.action === 'noop' && selfReconcile.reason === 'run_active_here',
    JSON.stringify(selfReconcile.reason));

  var cReconcile = await R(taskId, { store: s10 });
  ok('V2-R08T-17 另一页在超时后接管成功',
    cReconcile.action === 'finalized' && cReconcile.paused === true,
    JSON.stringify({ action: cReconcile.action }));

  gate({ ok: true, result: { value: 1 } });
  var runRes = await runAp;
  var finalRec = s10.raw(taskId);
  var finalState = T.fromJSON(finalRec.state);
  ok('V2-R08T-18 存活的运行页吸收 pausedAt 后以暂停收尾（不覆盖回运行态）',
    runRes && runRes.paused === true && !!finalState.pausedAt && !finalState.pauseRequestedAt,
    JSON.stringify({
      paused: runRes && runRes.paused, verdict: runRes && runRes.verdict,
      pausedAt: finalState.pausedAt, req: finalState.pauseRequestedAt
    }));
  var finalEvs = finalState.events.map(function (e) { return e.type; });
  ok('V2-R08T-19 收尾后仍保留 task.paused 事件（审计链不断）',
    finalEvs.indexOf('task.paused') >= 0, JSON.stringify(finalEvs));
  ok('V2-R08T-20 收尾后活跃运行释放',
    A.AstroControl._diagnostics().activeTaskIds.indexOf(taskId) < 0,
    JSON.stringify(A.AstroControl._diagnostics()));

  console.log('RESULT ' + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('UNEXPECTED', e && e.stack || e);
  process.exit(1);
});