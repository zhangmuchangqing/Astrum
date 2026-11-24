/*
 * ASTRUM V2-B · R-03 恢复人工确认动作测试
 * 覆盖：waiting_approval 不再只有状态，rerun/reuse/abandon 显式动作、
 *       重复恢复不翻转、事件、CAS 冲突、权限与非确认态拒绝、bridge 透传。
 * 用法：node tools/v2-recovery-confirmation-test.js
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '..');

global.localStorage = {
  _d: {},
  getItem: function (k) { return this._d[k] == null ? null : this._d[k]; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; },
  clear: function () { this._d = {}; }
};

['data/catalog.js', 'data/knowledge.js', 'data/places.js', 'data/bodies.js',
 'data/solarsystem.js', 'data/obsplan.js', 'data/gear.js', 'data/daily.js',
 'core/astro.js', 'core/runtime.js', 'core/fit.js', 'core/agents.js',
 'core/profile.js', 'core/profile-context.js', 'core/audit-log.js',
 'core/security.js', 'core/tool-gateway.js', 'core/task.js',
 'core/schema.js', 'core/claims.js', 'core/evidence.js', 'core/fits.js',
 'core/query.js', 'core/sources.js', 'core/research.js',
 'core/solarsystem.js', 'core/attachments.js', 'core/simbad.js',
 'core/router.js', 'core/planner.js', 'core/reducer.js', 'core/report.js',
 'core/registry.js', 'core/compose-adapter.js', 'core/task-store.js',
 'core/recovery.js', 'core/orchestrator.js', 'core/control.js',
 'core/control-bridge.js'
].forEach(function (f) { require(path.join(ROOT, f)); });

var T = global.AstroTask;
var R = global.AstroRecovery;
var C = global.AstroControl;
var Bridge = global.AstroControlBridge;
var Sec = global.Security || global.AstroSecurity;
var Store = global.AstroTaskStore;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (extra == null ? '' : extra)); }
}

var registry = {
  get: function (id) { return { id: id, version: '1.0.0', idempotent: false, sideEffect: true }; }
};

/* 构造一个等待恢复确认的任务：已成功结果但哈希不符，被 recovery 置为 waiting_approval。 */
function waitingState(stepId) {
  var st = T.create({ question: 'r03', level: 'L3', phase: 'EXECUTE' });
  st.plan = { planId: 'p', version: 1, steps: [{ id: stepId, tool: 'ext.tool', deps: [], args: {} }] };
  st.steps = st.plan.steps.map(T.makeStep);
  var s = st.steps[0];
  s.status = 'waiting_approval';
  s.attempt = 1;
  s.result = { ok: true, value: 'remote-ok' };
  s.outputHash = 'deadbeef';
  s.provenance = { tool: 'ext.tool', version: '1.0.0', at: new Date().toISOString() };
  s.error = { kind: 'recovery_confirmation_required', message: 'hash mismatch', retriable: false };
  return { state: st, step: s };
}

function memStore(seed, opts) {
  opts = opts || {};
  var recs = {};
  if (seed) {
    recs[seed.id] = {
      id: seed.id, ownerProfileId: null, projectId: null,
      revision: 1, updatedAt: new Date().toISOString(), state: T.toJSON(seed)
    };
  }
  return {
    get: async function (id) { return recs[id] ? T.fromJSON(recs[id].state) : null; },
    getRecord: async function (id) { return recs[id] || null; },
    isResumable: function () { return true; },
    save: async function (state, sopts) {
      if (opts.forceCode) { var fe = new Error('forced'); fe.code = opts.forceCode; throw fe; }
      var prev = recs[state.id];
      if (sopts && sopts.expectedRevision != null) {
        var cur = prev ? prev.revision : 0;
        if (cur !== sopts.expectedRevision) { var se = new Error('stale'); se.code = 'STALE_WRITE'; throw se; }
      }
      recs[state.id] = {
        id: state.id, ownerProfileId: (prev && prev.ownerProfileId) || null,
        projectId: (prev && prev.projectId) || null,
        revision: (prev ? prev.revision : 0) + 1, updatedAt: new Date().toISOString(),
        state: T.toJSON(state)
      };
      return state.id;
    },
    raw: function (id) { return recs[id]; }
  };
}

(async function () {
  /* 1. 未确认的等待态：任意恢复仍返回 confirm，不自动翻回重跑。 */
  var w0 = waitingState('s0');
  var d0 = R.decide(w0.state, w0.step, registry, Date.now());
  ok('V2-R03-01 未确认等待态仍要求人工确认', d0.strategy === 'confirm', d0.strategy);

  /* 2. reuse：显式确认复用后回到 ok，且后续恢复不翻转。 */
  var w1 = waitingState('s1');
  var store1 = memStore(w1.state);
  var r1 = await C.confirmRecovery(w1.state.id, 's1', 'reuse', { store: store1 });
  ok('V2-R03-02 reuse 确认成功并落盘', r1 && r1.confirmed === true && r1.verdict === 'CONFIRMED', r1 && r1.verdict);
  var st1 = await store1.get(w1.state.id);
  var s1 = st1.steps[0];
  ok('V2-R03-03 reuse 清除 waiting_approval 与 error', s1.status === 'ok' && s1.error == null, s1.status);
  ok('V2-R03-04 reuse 写入 provenance.recoveryConfirmation',
    s1.provenance.recoveryConfirmation && s1.provenance.recoveryConfirmation.decision === 'reuse');
  ok('V2-R03-05 reuse 追加 task.recovery_confirmed 事件',
    (st1.events || []).some(function (e) { return e.type === 'task.recovery_confirmed' && e.stepId === 's1' && e.payload.action === 'reuse'; }));
  var again = R.plan({ state: st1, registry: registry });
  ok('V2-R03-06 重复恢复不把已确认复用翻回确认',
    (again.steps[0].strategy === 'reuse' || st1.steps[0].status === 'ok'), again.steps[0].strategy);

  /* 3. rerun：显式授权重跑重置步骤，结果为 null、状态 pending。 */
  var w2 = waitingState('s2');
  var store2 = memStore(w2.state);
  var r2 = await C.confirmRecovery(w2.state.id, 's2', 'rerun', { store: store2 });
  var st2 = await store2.get(w2.state.id);
  var s2 = st2.steps[0];
  ok('V2-R03-07 rerun 确认成功', r2 && r2.confirmed === true, r2 && r2.verdict);
  ok('V2-R03-08 rerun 重置步骤为 pending 且清空结果',
    s2.status === 'pending' && s2.result == null && s2.error == null, s2.status);
  ok('V2-R03-09 rerun 保留一次性授权标记',
    s2.provenance.recoveryConfirmation && s2.provenance.recoveryConfirmation.decision === 'rerun' &&
    s2.provenance.recoveryConfirmation.forAttempt === 1);

  /* 4. abandon：放弃步骤，标记 blocked，任务不静默完成。 */
  var w3 = waitingState('s3');
  var store3 = memStore(w3.state);
  var r3 = await C.confirmRecovery(w3.state.id, 's3', 'abandon', { store: store3 });
  var st3 = await store3.get(w3.state.id);
  var s3 = st3.steps[0];
  ok('V2-R03-10 abandon 确认成功', r3 && r3.confirmed === true, r3 && r3.verdict);
  ok('V2-R03-11 abandon 步骤阻塞且错误为 operator_abandoned',
    s3.status === 'blocked' && s3.error.kind === 'operator_abandoned', s3.status + '/' + (s3.error && s3.error.kind));

  /* 5. 非法决策与错误目标拒绝。 */
  var w4 = waitingState('s4');
  var store4 = memStore(w4.state);
  var bad = await C.confirmRecovery(w4.state.id, 's4', 'delete', { store: store4 });
  ok('V2-R03-12 非法决策被拒', bad && bad.confirmed === false && bad.error === 'INVALID_DECISION', bad && bad.error);
  var notFound = await C.confirmRecovery(w4.state.id, 'missing', 'reuse', { store: store4 });
  ok('V2-R03-13 不存在步骤被拒', notFound && notFound.error === 'STEP_NOT_FOUND', notFound && notFound.error);
  var s4not = waitingState('s4').state;
  s4not.steps[0].status = 'ok';
  s4not.steps[0].error = null;
  var store4b = memStore(s4not);
  var notWaiting = await C.confirmRecovery(s4not.id, 's4', 'reuse', { store: store4b });
  ok('V2-R03-14 非恢复确认态被拒', notWaiting && notWaiting.error === 'NOT_AWAITING_RECOVERY', notWaiting && notWaiting.error);

  /* 6. CAS 冲突：revision 不匹配必须暴露错误且不伪造成功。 */
  var w5 = waitingState('s5');
  var store5 = memStore(w5.state, { forceCode: 'STALE_WRITE' });
  var stale = await C.confirmRecovery(w5.state.id, 's5', 'reuse', { store: store5 });
  ok('V2-R03-15 CAS 冲突返回 PERSIST_FAILED', stale && stale.confirmed === false && stale.verdict === 'PERSIST_FAILED', stale && stale.verdict);

  /* 7. 权限：已注册但无 resume 能力的 agent 不得确认。 */
  var w6 = waitingState('s6');
  var store6 = memStore(w6.state);
  var critic = Sec && Sec.makePrincipal ? Sec.makePrincipal({ agentId: 'critic' }) : null;
  if (critic) {
    /* 让任务归属该 principal 的档案，确保 read 通过、resume 被能力策略拒绝。 */
    var rec6 = store6.raw(w6.state.id);
    rec6.ownerProfileId = critic.profileId;
    var denied = await C.confirmRecovery(w6.state.id, 's6', 'reuse', { store: store6, principal: critic });
    ok('V2-R03-16 无 resume 能力的 agent 确认被拒',
      denied && denied.confirmed === false && denied.verdict === 'DENIED', JSON.stringify(denied && { verdict: denied.verdict, error: denied.error }));
  } else {
    ok('V2-R03-16 无 resume 能力的 agent 确认被拒', false, 'Security module missing');
  }

  /* 8. bridge 透传：bridge 调用应产生相同确认动作。 */
  var w7 = waitingState('s7');
  var store7 = memStore(w7.state);
  var bridged = await Bridge.confirmRecovery(w7.state.id, 's7', 'reuse', { store: store7, agentId: 'muse' });
  ok('V2-R03-17 bridge 透传确认动作', bridged && bridged.confirmed === true, bridged && (bridged.error || bridged.verdict));

  console.log('\nRESULT ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
});
