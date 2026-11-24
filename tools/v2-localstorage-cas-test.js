/*
 * ASTRUM V2-B · R-04 localStorage 降级后端跨标签页 CAS 测试
 * 覆盖：Web Locks 互斥下的 read-compare-write 原子性、多任务互不抹除、
 *       CAS 冲突、无 Web Locks 降级标记、锁命名空间隔离、IDB 不回归。
 * 用法：node tools/v2-localstorage-cas-test.js
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '..');

/* Node 24 自带 navigator.locks（进程内互斥），无 indexedDB → 走 localStorage 后端。 */
var LS = global.localStorage || {};
LS._d = LS._d || {};
LS.getItem = function (k) { return this._d[k] == null ? null : this._d[k]; };
LS.setItem = function (k, v) { this._d[k] = String(v); };
LS.removeItem = function (k) { delete this._d[k]; };
LS.clear = function () { this._d = {}; };
global.localStorage = LS;

['core/task.js', 'core/task-store.js'].forEach(function (f) { require(path.join(ROOT, f)); });
var T = global.AstroTask;
var S = global.AstroTaskStore;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (extra == null ? '' : extra)); }
}

var _realLocks = global.navigator && global.navigator.locks;

function fresh() {
  LS.clear();
  return function (opts) {
    var s = S.create(Object.assign({ ownerProfileId: 'shared' }, opts || {}));
    return s.init().then(function () { return s; });
  };
}

function newState(id, revisionValue) {
  var st = T.create({ question: 'r04-' + (revisionValue || 0), level: 'L1' });
  st.id = id || st.id;
  return st;
}

(async function () {
  /* 1. Web Locks 可用时，localStorage 后端 health 标记为跨标签原子。 */
  var mk = fresh();
  var a = await mk();
  var h = a.getHealth();
  ok('V2-R04-01 无 IDB 时走 localStorage 后端', h.backend === 'ls', h.backend);
  ok('V2-R04-02 Web Locks 可用 → crossTabAtomic', h.crossTabAtomic === true && h.lockMode === 'web-locks', JSON.stringify(h));

  /* 2. 两个 store 实例（模拟两标签页）并发保存同一任务，
   *    期望恰好一个成功、一个 STALE_WRITE，不丢更新。 */
  var st1 = newState('cas-shared', 1);
  await a.save(st1);
  var b = await mk();
  var stA = T.fromJSON(T.toJSON(st1));
  var stB = T.fromJSON(T.toJSON(st1));
  stA.question = 'r04-11';
  stB.question = 'r04-22';
  var results = await Promise.all([
    a.save(stA, { expectedRevision: 1 }).then(function () { return 'ok'; }, function (e) { return e && e.code || 'ERR'; }),
    b.save(stB, { expectedRevision: 1 }).then(function () { return 'ok'; }, function (e) { return e && e.code || 'ERR'; })
  ]);
  var wins = results.filter(function (r) { return r === 'ok'; }).length;
  var stale = results.filter(function (r) { return r === 'STALE_WRITE'; }).length;
  ok('V2-R04-03 并发 CAS 恰好一个成功', wins === 1, JSON.stringify(results));
  ok('V2-R04-04 另一个被 STALE_WRITE 拒绝', stale === 1, JSON.stringify(results));
  var final = await a.get('cas-shared');
  ok('V2-R04-05 最终值来自成功者，无覆盖丢更新',
    final.question === 'r04-11' || final.question === 'r04-22',
    final.question);

  /* 3. 两个实例并发保存不同任务，互不抹除（map 级原子）。 */
  var mk2 = fresh();
  var c = await mk2();
  var d = await mk2();
  var sC = newState('task-c', 1);
  var sD = newState('task-d', 2);
  await Promise.all([c.save(sC), d.save(sD)]);
  ok('V2-R04-06 并发保存不同任务互不抹除 A', !!(await c.get('task-c')), 'task-c missing');
  ok('V2-R04-07 并发保存不同任务互不抹除 B', !!(await d.get('task-d')), 'task-d missing');

  /* 4. 无 Web Locks 时降级为同上下文同步段，且 health 明确不跨标签原子。 */
  var savedDescriptor = Object.getOwnPropertyDescriptor(global.navigator, 'locks');
  try {
    Object.defineProperty(global.navigator, 'locks', { configurable: true, value: undefined });
    var mk3 = fresh();
    var e = await mk3();
    var he = e.getHealth();
    ok('V2-R04-08 无 Web Locks → crossTabAtomic=false', he.crossTabAtomic === false && he.lockMode === 'same-context-only', JSON.stringify(he));
    var se = newState('nolock', 1);
    await e.save(se);
    ok('V2-R04-09 无 Web Locks 仍能单上下文保存', !!(await e.get('nolock')), 'save failed');
  } finally {
    if (savedDescriptor) {
      Object.defineProperty(global.navigator, 'locks', savedDescriptor);
    } else if (global.navigator) {
      delete global.navigator.locks;
    }
  }

  /* 5. 锁名按 owner 命名空间隔离：不同 owner 不互相争用。 */
  var l1 = S.create({ ownerProfileId: 'owner-a' });
  var l2 = S.create({ ownerProfileId: 'owner-b' });
  await Promise.all([l1.init(), l2.init()]);
  var ha = l1.getHealth(), hb = l2.getHealth();
  ok('V2-R04-10 不同 owner 均走 ls 后端', ha.backend === 'ls' && hb.backend === 'ls', ha.backend + '/' + hb.backend);
  ok('V2-R04-11 锁名含命名空间隔离', ha.lockMode === 'web-locks' && hb.lockMode === 'web-locks');

  console.log('\nRESULT ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
});
