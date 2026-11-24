/* ASTRUM V2-B · R-08 跨标签页暂停通知（BroadcastChannel 加速中止）测试
 *
 * 受控 sandbox 重载 control.js：注入两个互联的假 BroadcastChannel 模拟两个标签页，
 * 并让 A 页真实 run() 卡在门控慢工具上，B 页从同一共享 store 调 pause()，验证：
 *   - pause() 跨页写请求后确实广播（announced=true，payload 正确）
 *   - 运行页 A 收到 pause-request 后立即中止在飞步骤（不等批次边界轮询）
 *   - A 页在安全边界后经 CAS 权威确认 PAUSED（消息本身不直接置 PAUSED）
 *   - 无 BroadcastChannel 时退化为轮询（announced=false，语义不变，不报错）
 *   - 收尾后活跃运行释放，不残留
 *
 * 用法：node tools/v2-cross-tab-pause-test.js
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
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

/* 互联的假 BroadcastChannel（模拟两个标签页共享同名频道）。 */
function makeBCWorld() {
  var channels = [];
  var BC = function (name) {
    this.name = name;
    this.onmessage = null;
    this.posted = [];
    channels.push(this);
  };
  BC.prototype.postMessage = function (data) {
    this.posted.push(data);
    for (var i = 0; i < channels.length; i++) {
      var c = channels[i];
      if (c !== this && c.name === this.name && typeof c.onmessage === 'function') {
        try { c.onmessage({ data: JSON.parse(JSON.stringify(data)) }); } catch (e) {}
      }
    }
  };
  BC.prototype.close = function () {};
  return { BC: BC, channels: channels };
}

/* 共享内存 store：revision 递增 + expectedRevision 校验。 */
function sharedStore() {
  var recs = {};
  return {
    ownerProfileId: function () { return null; },
    get: async function (id) { return recs[id] ? T.fromJSON(recs[id].state) : null; },
    getRecord: async function (id) { return recs[id] || null; },
    isResumable: function () { return true; },
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

/* 在给定 window 沙箱中加载 control.js，window 挂载 AstroControl 与依赖。 */
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

(async function () {
  var deps = {
    AC: { resolveTargets: function () { return []; }, detectIntent: function () { return 'research'; } },
    Router: { route: function () { return { mode: 'research', level: 'L3', legacy: false, targets: [] }; } },
    Planner: { plan: function () { return { planId: 'p', version: 1, steps: [{ id: 's1', tool: 'slow', deps: [], args: {} }] }; } }
  };

  /* --- 场景 A：双标签页互联 --- */
  var world = makeBCWorld();
  var winA = {}, winB = {};
  var A = loadControl(winA, world.BC, deps);
  var B = loadControl(winB, world.BC, deps);

  var store = sharedStore();
  var slowAborted = false;
  var registryA = {
    list: function () { return ['slow']; },
    get: function () {
      return {
        id: 'id', version: '1', timeoutMs: 5000, idempotent: true, abortable: true,
        run: function (a, c, sp, cf, d, rt) {
          return new Promise(function (resolve) {
            if (rt && rt.signal && rt.signal.addEventListener) {
              rt.signal.addEventListener('abort', function () {
                slowAborted = true;
                resolve({ ok: false, reason: 'cancelled', kind: 'cancelled', retriable: false });
              });
            }
          });
        }
      };
    }
  };

  var taskId = null;
  var runAp = A.AstroControl.run('cross-tab pause', {}, {}, {
    store: store,
    registry: registryA,
    routeData: { targets: [], intent: 'research', route: { mode: 'research', level: 'L3', legacy: false, targets: [] } },
    onTask: function (id) { taskId = id; }
  });
  await waitFor(function () { return !!taskId; }, 2000);
  ok('R8-01 A 页 run 已进入执行并暴露 taskId', !!taskId, String(taskId));

  var diag1 = A.AstroControl._diagnostics();
  ok('R8-02 A 页活跃任务在录', diag1.activeTaskIds.indexOf(taskId) >= 0, JSON.stringify(diag1));

  /* B 页从共享 store 读同一任务（running step），调 pause → 应广播。 */
  var pr = await B.AstroControl.pause(taskId, { store: store });
  ok('R8-03 B 页跨页 pause 返回 PAUSE_REQUESTED 且声明已广播',
    pr && pr.verdict === 'PAUSE_REQUESTED' && pr.pauseRequested === true && pr.announced === true,
    JSON.stringify({ verdict: pr && pr.verdict, announced: pr && pr.announced }));
  var posted = world.channels
    .map(function (c) { return c.posted; })
    .reduce(function (a, b) { return a.concat(b); }, []);
  ok('R8-04 广播消息含正确 taskId 与 pause-request 类型',
    posted.some(function (m) { return m && m.type === 'pause-request' && m.taskId === taskId; }),
    JSON.stringify(posted));
  ok('R8-04b 运行页 A 已建立接收端通道',
    A.AstroControl._diagnostics().channelActive === true,
    JSON.stringify(A.AstroControl._diagnostics()));

  /* A 页收到消息后应立即中止在飞步骤（不等批次边界轮询）。 */
  await waitFor(function () { return slowAborted; }, 1500);
  ok('R8-05 运行页 A 收到通知后立即中止在飞步骤', slowAborted === true);

  var runRes = await runAp;
  ok('R8-06 运行页 A 以 PAUSED 收尾（权威确认在安全边界后，非消息直接置位）',
    runRes && runRes.paused === true && runRes.verdict === 'PAUSED',
    JSON.stringify({ paused: runRes && runRes.paused, verdict: runRes && runRes.verdict }));
  var persisted = store.raw(taskId);
  var persistedState = persisted ? T.fromJSON(persisted.state) : null;
  ok('R8-07 持久化任务含 pausedAt 且 pauseRequestedAt 已清空',
    !!(persistedState && persistedState.pausedAt) && !persistedState.pauseRequestedAt,
    JSON.stringify(persistedState && { pausedAt: persistedState.pausedAt, pauseRequestedAt: persistedState.pauseRequestedAt }));
  var evTypes = (persistedState.events || []).map(function (e) { return e.type; });
  /* 权威事件来自运行页 A：安全边界（step.paused）+ 确认（task.paused）。
   * task.pause_requested 属请求方（B 页）记录，会被 A 的权威保存取代，不作为断言。 */
  ok('R8-08 权威事件链含 step.paused 与 task.paused',
    evTypes.indexOf('step.paused') >= 0 && evTypes.indexOf('task.paused') >= 0,
    JSON.stringify(evTypes));

  var diag2 = A.AstroControl._diagnostics();
  ok('R8-09 收尾后 A 页活跃运行已释放（不残留）',
    diag2.activeTaskIds.indexOf(taskId) < 0, JSON.stringify(diag2));

  /* --- 场景 B：无 BroadcastChannel → 退化为轮询 --- */
  var winN = {};
  var N = loadControl(winN, undefined, deps);
  var storeN = sharedStore();
  var taskIdN = null;
  var runNp = N.AstroControl.run('cross-tab pause no-bc', {}, {}, {
    store: storeN,
    registry: registryA,
    routeData: { targets: [], intent: 'research', route: { mode: 'research', level: 'L3', legacy: false, targets: [] } },
    onTask: function (id) { taskIdN = id; }
  });
  await waitFor(function () { return !!taskIdN; }, 2000);
  ok('R8-10 无 BC 场景 A 页进入执行', !!taskIdN);

  /* N 页自身即是运行页：同页路径不应依赖广播（已有 abortActive）。 */
  var prN = await N.AstroControl.pause(taskIdN, { store: storeN });
  ok('R8-11 无 BC 同页 pause 正常（不报错）',
    prN && (prN.verdict === 'PAUSE_REQUESTED' || prN.verdict === 'PAUSED'),
    JSON.stringify({ verdict: prN && prN.verdict }));
  ok('R8-12 无 BC 时不创建通道（channelActive=false）',
    N.AstroControl._diagnostics().channelActive === false);
  var runResN = await runNp;
  ok('R8-13 无 BC 收尾仍正确（PAUSED）',
    runResN && runResN.verdict === 'PAUSED', JSON.stringify({ verdict: runResN && runResN.verdict }));

  console.log('RESULT ' + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('UNEXPECTED', e && e.stack || e);
  process.exit(1);
});