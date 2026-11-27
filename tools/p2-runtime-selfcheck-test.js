/* ASTRUM · P2-3 模型探测真实性测试
 *
 * 回归目标：HTTP 200 但 content 为空时，测试连接必须判失败，
 * 不能把「接口可达」误报成「模型可用」。
 */
'use strict';
var path = require('path');
var ROOT = path.resolve(__dirname, '..');

global.localStorage = { _d: {}, getItem: function (k) { return this._d[k] || null; }, setItem: function (k, v) { this._d[k] = v; }, removeItem: function (k) { delete this._d[k]; } };
[
  'data/catalog.js', 'data/knowledge.js', 'data/places.js', 'data/bodies.js',
  'data/solarsystem.js', 'data/obsplan.js', 'data/gear.js', 'data/daily.js',
  'core/astro.js', 'core/task.js', 'core/schema.js', 'core/agents.js',
  'core/sources.js'
].forEach(function (f) { require(path.join(ROOT, f)); });

var S = global.Sources;
var results = [];
function ok(name, cond, extra) { results.push({ name: name, pass: !!cond, extra: extra || '' }); }

function stubFetch(payload) {
  global.fetch = function () {
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(payload); }
    });
  };
}

(async function main() {
  S.setConfig('deepseek', {
    key: 'test-key-not-real',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  });

  /* 1) 200 + 空 content → 失败 */
  stubFetch({ choices: [{ message: { role: 'assistant', content: '' } }] });
  var r1 = await S.test('deepseek');
  ok('空内容判失败', r1 && r1.ok === false, JSON.stringify(r1));
  ok('空内容错误可见', r1 && /空内容/.test(r1.msg || ''), r1 && r1.msg);
  ok('空内容不标记 ready', (S.statusOf('deepseek') || {}).state !== 'ready',
    JSON.stringify(S.statusOf('deepseek')));

  /* 2) 200 + 正常 content → 成功 */
  stubFetch({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
  var r2 = await S.test('deepseek');
  ok('正常内容判成功', r2 && r2.ok === true, JSON.stringify(r2));
  ok('成功标记 ready', (S.statusOf('deepseek') || {}).state === 'ready',
    JSON.stringify(S.statusOf('deepseek')));

  /* 3) 非 JSON 响应 → 失败且不得抛到界面之外 */
  global.fetch = function () {
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.reject(new Error('bad json')); }
    });
  };
  var r3 = await S.test('deepseek');
  ok('解析失败可分类', r3 && r3.ok === false, JSON.stringify(r3));

  var passed = results.filter(function (x) { return x.pass; }).length;
  results.forEach(function (x) {
    console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + (x.extra ? ' · ' + x.extra : ''));
  });
  console.log('\n' + passed + '/' + results.length + ' passed');
  process.exit(passed === results.length ? 0 : 1);
})().catch(function (e) {
  console.error('UNCAUGHT', e && e.stack || e);
  process.exit(1);
});
