/*
 * ASTRUM V2-B · R-09 检查点裁剪隔离性测试
 * 覆盖：
 *   1) pruneCheckpoints 失败不影响权威记录一致性（save 仍成功、revision 递增、可读）；
 *   2) 裁剪是主事务之后的独立事务：只删除派生检查点，权威 tasks 记录已在主事务落定；
 *   3) 正常路径会把多余检查点裁剪到 CP_KEEP；
 *   4) 内存态 Task.checkpoint 自身维持最近 20 个，version 不因裁剪重置。
 * 用法：node tools/v2-checkpoint-prune-test.js
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '..');

global.localStorage = {
  _d: {},
  getItem: function (k) { return this._d[k] == null ? null : this._d[k]; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; },
  key: function (i) { return Object.keys(this._d)[i] || null; },
  get length() { return Object.keys(this._d).length; }
};

var fake = require('./fake-idb').install();
require(path.join(ROOT, 'core/task.js'));
require(path.join(ROOT, 'core/task-store.js'));

var T = global.AstroTask;
var S = global.AstroTaskStore;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (extra == null ? '' : extra)); }
}

function mkState(question) {
  var st = T.create({ question: question, phase: 'EXECUTE', level: 'L2' });
  st.plan = { planId: 'p1', version: 1, steps: [{ id: 's1', tool: 'kb.lookup', deps: [], args: {} }] };
  st.steps = [T.makeStep(st.plan.steps[0])];
  T.addCheckpoint(st, { stepId: 's1' });
  return st;
}

function cpStore() { return fake.db(S.DB_NAME)._stores.checkpoints.data; }
function cpCount(taskId) {
  var data = cpStore();
  return Object.keys(data).filter(function (k) { return data[k] && data[k].taskId === taskId; }).length;
}

/* 直接向派生检查点索引注入"历史多余"记录，模拟旧版本遗留下来、尚未裁剪的派生数据。 */
function injectOldCheckpoints(taskId, n) {
  var data = cpStore();
  for (var i = 0; i < n; i++) {
    var id = 'chk_old_' + i;
    data[JSON.stringify(id)] = {
      checkpointId: id,
      taskId: taskId,
      ownerProfileId: null,
      projectId: null,
      version: i + 1,
      at: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      phase: 'EXECUTE'
    };
  }
}

(async function () {
  var store = S.create({});

  /* 1. 基线：一次正常保存，派生检查点索引只有本任务自己的记录。 */
  var st = mkState('裁剪基线');
  var id = await store.save(st, { expectedRevision: 0 });
  var rec1 = await store.getRecord(id);
  ok('V2-CP-01 基线保存 revision=1', rec1 && rec1.revision === 1, rec1 && rec1.revision);
  var baseCount = cpCount(id);
  ok('V2-CP-02 基线派生检查点数等于内存检查点数', baseCount === 1, baseCount);

  /* 2. 注入多余派生检查点，制造 > CP_KEEP 的待裁剪规模。 */
  injectOldCheckpoints(id, 22);
  var inflated = cpCount(id);
  ok('V2-CP-03 已构造超过保留上限的派生检查点', inflated > 20, inflated);

  /* 3. 注入 delete 失败：裁剪事务必然失败。
   *    若裁剪与权威保存同事务，save 会整体失败；实际必须成功。 */
  var next = T.fromJSON(rec1.state);
  next.question = '裁剪失败后仍可写';
  fake.failNextDelete('UnknownError');
  var threw = null, savedId = null;
  try { savedId = await store.save(next, { expectedRevision: 1 }); } catch (e) { threw = e; }
  ok('V2-CP-04 裁剪事务失败不阻断保存', !threw, threw && (threw.code || threw.message));
  ok('V2-CP-05 保存仍返回任务 id', savedId === id, savedId);

  /* 4. 权威记录一致性：revision 递增、内容为新写入、读取可用。 */
  var rec2 = await store.getRecord(id);
  var q2 = T.fromJSON(rec2.state);
  ok('V2-CP-06 权威记录 revision 递增', rec2.revision === 2, rec2.revision);
  ok('V2-CP-07 权威记录写入内容一致', q2.question === '裁剪失败后仍可写', q2.question);
  var loaded = await store.get(id);
  ok('V2-CP-08 裁剪失败后仍可按 id 读取', loaded && loaded.question === '裁剪失败后仍可写');

  /* 5. 裁剪失败只留下派生冗余：检查点索引未被部分删除。 */
  var afterFail = cpCount(id);
  ok('V2-CP-09 裁剪失败未产生部分删除', afterFail === inflated, afterFail + '/' + inflated);
  var latest = await store.loadLatestCheckpoint(id);
  ok('V2-CP-10 裁剪失败后仍可读取最新检查点', !!(latest && latest.checkpointId), latest && latest.checkpointId);

  /* 6. 直接调用裁剪在失败时确实 reject（证明 save 中的吞错是必要隔离层）。 */
  fake.failNextDelete('UnknownError');
  var directErr = null;
  try { await store.pruneCheckpoints(id, 20); } catch (e) { directErr = e; }
  ok('V2-CP-11 裁剪直接调用失败时 reject', !!directErr, directErr && (directErr.code || directErr.message));

  /* 7. 正常路径：恢复后裁剪生效，派生索引回落到上限。 */
  var rec3 = await store.getRecord(id);
  var st3 = T.fromJSON(rec3.state);
  st3.question = '裁剪恢复';
  await store.save(st3, { expectedRevision: rec3.revision });
  var prunedCount = cpCount(id);
  ok('V2-CP-12 正常保存后裁剪到保留上限', prunedCount === 20, prunedCount);

  /* 8. 权威记录不受裁剪影响：裁剪只作用于派生索引。 */
  var rec4 = await store.getRecord(id);
  ok('V2-CP-13 裁剪后权威 revision 继续递增', rec4.revision === 3, rec4.revision);
  ok('V2-CP-14 裁剪后权威内容一致', T.fromJSON(rec4.state).question === '裁剪恢复');

  /* 9. 内存态：Task.checkpoint 自身维持最近 20 个，version 连续递增、不重置。 */
  var mem = mkState('内存裁剪');
  var lastVersion = mem.checkpoints[0].version;
  for (var i = 0; i < 24; i++) {
    var cp = T.addCheckpoint(mem, { stepId: 's1' });
    lastVersion = cp.version;
  }
  ok('V2-CP-15 内存检查点维持 20 个上限', mem.checkpoints.length === 20, mem.checkpoints.length);
  ok('V2-CP-16 裁剪后 version 连续递增未重置', lastVersion === 25, lastVersion);
  var versions = mem.checkpoints.map(function (c) { return c.version; });
  var monotonic = versions.every(function (v, idx) { return idx === 0 || v > versions[idx - 1]; });
  ok('V2-CP-17 保留下来的检查点 version 单调递增', monotonic, versions.join(','));

  console.log('\nRESULT ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('FAIL | 异常 | ' + (e && e.stack));
  console.log('\nRESULT ' + pass + '/' + (pass + fail + 1));
  process.exit(1);
});
