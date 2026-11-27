'use strict';
/* V2 P0-E · 模型分级 / 缓存 / 去重 / 成本 / 并发（mock fetch，离线） */

var path = require('path');

var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
};

require(path.join(__dirname, '..', 'core', 'sources.js'));
require(path.join(__dirname, '..', 'core', 'task.js'));
require(path.join(__dirname, '..', 'core', 'model-gateway.js'));

var S = globalThis.Sources;
var T = globalThis.AstroTask;
var G = globalThis.AstroModelGateway;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

S.setConfig('deepseek', { key: 'k', endpoint: 'https://mock.local/v1/chat/completions', model: 'mock-base' });

var calls = [];
function mockFetch(handler) {
  calls = [];
  global.fetch = function (url, opts) {
    var body = null;
    try { body = JSON.parse(opts.body || '{}'); } catch (e) { body = null; }
    calls.push({ url: url, body: body });
    return Promise.resolve(handler(body, calls.length));
  };
}
function jsonRes(obj) {
  return {
    ok: true, status: 200,
    headers: { get: function () { return null; } },
    text: function () { return Promise.resolve(JSON.stringify(obj)); },
    json: function () { return Promise.resolve(obj); }
  };
}
function textOut(text, tokens) {
  return jsonRes({
    id: 'r',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: tokens || 12 }
  });
}
function msg(text) { return [{ role: 'user', content: text }]; }

async function main() {
  console.log('\n== P0-E 成本与稳定性 ==');

  /* 1. 缓存命中：相同请求只发一次 */
  G.clearCache(); G.resetStats();
  mockFetch(function () { return textOut('缓存结果'); });
  var a1 = await G.generate({ sourceId: 'deepseek', messages: msg('同一个问题') });
  var a2 = await G.generate({ sourceId: 'deepseek', messages: msg('同一个问题') });
  eq('首次请求数', calls.length, 1);
  eq('缓存命中结果', a2.text, '缓存结果');
  eq('缓存命中标记', a2.cacheHit, true);
  eq('缓存命中计数', G.stats().cacheHits, 1);

  /* 2. 显式关闭缓存 */
  G.clearCache();
  mockFetch(function () { return textOut('不缓存'); });
  await G.generate({ sourceId: 'deepseek', messages: msg('关闭缓存'), cache: false });
  await G.generate({ sourceId: 'deepseek', messages: msg('关闭缓存'), cache: false });
  eq('关闭缓存后请求数', calls.length, 2);

  /* 3. 并发去重：相同请求共享一次上游调用 */
  G.clearCache(); G.resetStats();
  mockFetch(function () { return new Promise(function (resolve) { setTimeout(function () { resolve(textOut('共享结果')); }, 30); }); });
  var both = await Promise.all([
    G.generate({ sourceId: 'deepseek', messages: msg('并发同一问题') }),
    G.generate({ sourceId: 'deepseek', messages: msg('并发同一问题') })
  ]);
  eq('并发去重请求数', calls.length, 1);
  ok('并发结果一致', both[0].text === '共享结果' && both[1].text === '共享结果');
  eq('去重计数', G.stats().dedupes, 1);

  /* 4. 模型分级：L3 → deep，请求体真实覆盖模型 */
  G.clearCache();
  G.setTierMapping('deepseek', { fast: 'm-fast', standard: 'm-std', deep: 'm-deep' });
  mockFetch(function () { return textOut('分级'); });
  var st = T.create({ id: 't-tier', level: 'L3' });
  var a4 = await G.generate({ sourceId: 'deepseek', messages: msg('分级问题'), state: st });
  eq('L3 请求模型', calls[0].body.model, 'm-deep');
  eq('L3 返回档位', a4.modelTier, 'deep');
  eq('L1 档位', G.tierForLevel('L1'), 'fast');
  eq('L4 档位', G.tierForLevel('L4'), 'deep');
  G.setTierMapping('deepseek', null);

  /* 5. 成本聚合：只累计真实 usage */
  G.clearCache();
  mockFetch(function () { return textOut('成本'); });
  var st5 = T.create({ id: 't-cost', level: 'L2' });
  st5.budget.limit.llmCalls = 10;
  st5.budget.limit.tokens = 100000;
  await G.generate({ sourceId: 'deepseek', messages: msg('成本一'), state: st5, cache: false });
  await G.generate({ sourceId: 'deepseek', messages: msg('成本二'), state: st5, cache: false });
  eq('成本调用次数', st5.cost.calls, 2);
  eq('成本总 token', st5.cost.totalTokens, 24);
  eq('成本无价格表', st5.cost.estimatedCost, null);

  /* 6. 并发上限：并发 6 个请求，最大活跃不超过 4 */
  G.clearCache(); G.resetStats();
  mockFetch(function () { return new Promise(function (resolve) { setTimeout(function () { resolve(textOut('并发')); }, 25); }); });
  var tasks = [];
  for (var i = 0; i < 6; i++) tasks.push(G.generate({ sourceId: 'deepseek', messages: msg('并发-' + i), cache: false }));
  await Promise.all(tasks);
  ok('并发上限 <= 4', G.stats().maxActive <= 4, 'maxActive=' + G.stats().maxActive);
  ok('并发上限被使用', G.stats().maxActive >= 1);

  /* 7. 缓存不缓存失败结果 */
  G.clearCache();
  mockFetch(function () { return jsonRes(401, 'bad key'); });
  var f1 = await G.generate({ sourceId: 'deepseek', messages: msg('失败不缓存'), maxRetries: 0 });
  var f2 = await G.generate({ sourceId: 'deepseek', messages: msg('失败不缓存'), maxRetries: 0 });
  eq('失败不缓存请求数', calls.length, 2);
  eq('失败状态', f1.status, 'failed');
  eq('失败仍失败', f2.status, 'failed');

  console.log('\nP0-E 结果：' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1; }
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
