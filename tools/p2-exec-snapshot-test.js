/* ASTRUM · 执行快照面板与真实步骤面板语义隔离回归（零依赖）
 *
 * 背景：execSnapshotPanel 曾复用 .step-panel 类名，导致 legacy 答案的
 *       「执行记录 · 未执行」快照被 simpleLike 当成真实执行步骤，
 *       简单答案因此展开详情并出现 .trace-fold。
 *
 * 覆盖：
 *   1) 浏览器（当前源码 index.html）：简单答案无 .step-panel / .exec-snapshot-panel /
 *      .trace-fold / .answer-details，且叙述层正常渲染；
 *   2) 源码契约：execSnapshotPanel 只用 exec-snapshot-panel，stepPanel 只用 step-panel，
 *      快照节点不进入 simpleLike 判定，而是随详情节区展示；
 *   3) 样式契约：assets/app.css 同时定义两个选择器；
 *   4) 真实步骤面板仍由 step-panel 渲染（由 v1-6-browser-test 覆盖，见报告）。
 *
 * 用法：node tools/p2-exec-snapshot-test.js [file-url]
 *       默认目标为本仓库 index.html（当前源码），不使用陈旧构建产物。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

function findChrome() {
  var c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (var i = 0; i < c.length; i++) { if (fs.existsSync(c[i])) return c[i]; }
  var names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  var dirs = (process.env.PATH || '').split(path.delimiter);
  for (var n = 0; n < names.length; n++) {
    for (var d = 0; d < dirs.length; d++) {
      if (!dirs[d]) continue;
      var p = path.join(dirs[d], names[n]);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  return 'chrome';
}

var ROOT = path.resolve(__dirname, '..');
var CHROME = findChrome();
var TARGET = process.argv[2] || ('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));

var ASSERT = [
  '<script>',
  '(function(){',
  '  var R = [];',
  '  function ok(n, c, x) { R.push({ n: n, p: !!c, x: x || "" }); }',
  '  function finish() {',
  '    var t = R.filter(function (r) { return r.p; }).length;',
  '    var pre = document.createElement("pre"); pre.id = "__exectest_result";',
  '    pre.textContent = "RESULT " + t + "/" + R.length + "\\n" + R.map(function (r) {',
  '      return (r.p ? "PASS" : "FAIL") + " | " + r.n + " | " + r.x;',
  '    }).join("\\n");',
  '    document.body.appendChild(pre);',
  '  }',
  '  function start() {',
  '    if (!window.__astrum || !window.__astrum.ask) { setTimeout(start, 20); return; }',
  '    var before = document.querySelectorAll(".msg.bot").length;',
  '    window.__astrum.ask("猎户座大星云是什么");',
  '    var n = 0;',
  '    (function w(){',
  '      var all = document.querySelectorAll(".msg.bot");',
  '      var bot = all.length > before ? all[before] : null;',
  '      var narr = bot && bot.querySelector(".narr");',
  '      if (!narr && n++ < 150) { setTimeout(w, 100); return; }',
  '      var sp = bot && bot.querySelector(".step-panel");',
  '      var es = bot && bot.querySelector(".exec-snapshot-panel");',
  '      var tf = bot && bot.querySelector(".trace-fold");',
  '      var ad = bot && bot.querySelector(".answer-details");',
  '      ok("简单答案已渲染叙述层", !!narr, narr ? "ok" : "timeout: narr not rendered");',
  '      ok("简单答案不出现真实步骤面板", !sp, sp ? "step-panel present" : "hidden");',
  '      ok("简单答案不出现执行快照面板", !es, es ? "exec-snapshot-panel present" : "hidden");',
  '      ok("简单答案不出现 trace-fold", !tf, tf ? "trace-fold present" : "hidden");',
  '      ok("简单答案不展开详情区", !ad, ad ? "answer-details present" : "hidden");',
  '      finish();',
  '    })();',
  '  }',
  '  start();',
  '})();',
  '</script>'
].join('\n');

var results = [];
function ok(name, cond, info) { results.push({ n: name, p: !!cond, x: info || '' }); }

/* ---- 源码与样式契约（静态，不依赖浏览器） ---- */
var app = fs.readFileSync(path.join(ROOT, 'core', 'app.js'), 'utf8');
var css = fs.readFileSync(path.join(ROOT, 'assets', 'app.css'), 'utf8');

ok('execSnapshotPanel 使用独立类名 exec-snapshot-panel',
  /function execSnapshotPanel\(exec\)[\s\S]{0,400}?el\('details', 'exec-snapshot-panel'\)/.test(app),
  'source');
ok('execSnapshotPanel 不再使用 step-panel',
  !/function execSnapshotPanel\(exec\)[\s\S]{0,400}?el\('details', 'step-panel'\)/.test(app),
  'source');
ok('真实步骤面板 stepPanel 仍使用 step-panel',
  /function stepPanel\([\s\S]{0,300}?el\('details', 'step-panel'\)/.test(app),
  'source');
ok('渲染层单独摘下执行快照节点',
  /detachDirect\('exec-snapshot-panel'\)/.test(app), 'source');
ok('执行快照节点进入详情节区而非 simpleLike 判定',
  /detailNodes\.push\(execMetaNodeDetached\)/.test(app), 'source');
ok('simpleLike 未引用 exec-snapshot-panel',
  !/var simpleLike\s*=[^\n]*exec-snapshot-panel/.test(app), 'source');
ok('样式同时定义 .step-panel 与 .exec-snapshot-panel',
  /\.step-panel,\s*\.exec-snapshot-panel\s*\{/.test(css), 'css');

/* ---- 浏览器：当前源码 index.html ---- */
var html = fs.readFileSync(TARGET.replace(/^file:\/\/\//, '').replace(/\//g, path.sep), 'utf8');
var multi = /<script src=/.test(html);
var tmp = multi
  ? path.join(path.dirname(TARGET.replace(/^file:\/\/\//, '').replace(/\//g, path.sep)), '__exectest_tmp.html')
  : path.join(require('os').tmpdir(), '__exectest_' + Date.now() + '.html');
var idx = html.lastIndexOf('</body>');
var patched = html.slice(0, idx) + ASSERT + html.slice(idx);
/* 注入脚本同样受 CSP 约束，需放行内联，避免“页面没反应”的假失败 */
patched = patched.replace(
  /(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src\s+)([^;]*?)(;)/,
  function (_, h, m, t) { return h + "'self' 'unsafe-inline'" + t; }
);
fs.writeFileSync(tmp, patched, 'utf8');

var out = cp.spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1440,900', '--virtual-time-budget=40000', '--dump-dom',
  'file:///' + tmp.replace(/\\/g, '/')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}

var text = (out.stdout || '') + (out.stderr || '');
var m = text.match(/<pre id="__exectest_result">([\s\S]*?)<\/pre>/);
if (!m) {
  ok('浏览器用例取得结果', false, 'no result (chrome ' + (out.status === null ? 'timeout' : out.status) + ')');
} else {
  m[1].split('\n').forEach(function (line) {
    var mm = line.replace(/\r$/, '').match(/^(PASS|FAIL) \| (.*?) \| (.*)$/);
    if (mm) ok(mm[2], mm[1] === 'PASS', mm[3]);
  });
}

var pass = results.filter(function (r) { return r.p; }).length;
results.forEach(function (r) {
  console.log((r.p ? 'PASS' : 'FAIL') + ' | ' + r.n + (r.x ? ' | ' + r.x : ''));
});
console.log('RESULT ' + pass + '/' + results.length);
process.exit(pass === results.length ? 0 : 1);
