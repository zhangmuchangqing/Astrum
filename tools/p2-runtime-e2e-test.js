'use strict';
/* V2 阶段 I · Runtime 开关真实页面 e2e（headless Chrome）
 * 场景：默认关闭 / URL 开启 / 设置开启 / URL 覆盖设置关闭
 * 只读断言 window.ASTRUM_AGENT_RUNTIME 与来源，不改业务代码。 */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var os = require('os');
var ROOT = path.resolve(__dirname, '..');

function findChrome() {
  var c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (var i = 0; i < c.length; i++) { if (fs.existsSync(c[i])) return c[i]; }
  return 'chrome';
}

var script = `
(function () {
  var SEED = __SEED__, EXP_ON = __EXP_ON__, EXP_SRC = '__EXP_SRC__';
  function emit() {
    var R = [];
    function ok(n, p, x) { R.push({ n: n, p: !!p, x: x === undefined ? '' : String(x) }); }
    ok('生效值', window.ASTRUM_AGENT_RUNTIME === EXP_ON, String(window.ASTRUM_AGENT_RUNTIME));
    ok('来源', window.ASTRUM_AGENT_RUNTIME_SOURCE === EXP_SRC, String(window.ASTRUM_AGENT_RUNTIME_SOURCE));
    var pre = document.createElement('pre');
    pre.id = '__rt_result';
    pre.textContent = 'RESULT ' + R.filter(function (r) { return r.p; }).length + '/' + R.length + '\\n' +
      R.map(function (r) { return (r.p ? 'PASS' : 'FAIL') + ' | ' + r.n + ' | ' + r.x; }).join('\\n');
    document.body.appendChild(pre);
  }
  if (SEED && !sessionStorage.getItem('__rt_phase')) {
    try {
      var cur = {};
      try { cur = JSON.parse(localStorage.getItem('astrum.v2') || '{}') || {}; } catch (e) { cur = {}; }
      var st = Object.assign({}, cur.settings || {}, { agentRuntime: true });
      var raw = JSON.stringify(Object.assign({}, cur, { settings: st }));
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/astrum\\.v2/.test(k)) keys.push(k);
      }
      if (!keys.length) keys.push('astrum.v2');
      keys.forEach(function (k) { try { localStorage.setItem(k, raw); } catch (e) {} });
      sessionStorage.setItem('__rt_phase', 'seeded');
      location.reload();
      return;
    } catch (e) { /* 继续，用当前状态断言 */ }
  }
  setTimeout(emit, 500);
})();
`;

function build(query, seed, expOn, expSrc) {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(
    /(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src\s+)([^;]*?)(;)/,
    function (m, a, b, c) { return a + "'self' 'unsafe-inline'" + c; }
  );
  var body = script
    .replace('__SEED__', seed ? 'true' : 'false')
    .replace('__EXP_ON__', expOn ? 'true' : 'false')
    .replace('__EXP_SRC__', expSrc);
  var idx = html.lastIndexOf('</body>');
  html = html.slice(0, idx) + '<script>' + body + '</script>' + html.slice(idx);
  return html;
}

function run(name, query, seed, expOn, expSrc) {
  var html = build(query, seed, expOn, expSrc);
  var tmp = path.join(ROOT, '__rt_test_' + name + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  var profile = path.join(os.tmpdir(), '__rt_profile_' + name + '_' + process.pid + '_' + Date.now());
  var url = 'file:///' + tmp.replace(/\\/g, '/') + (query || '');
  var out;
  try {
    out = cp.execFileSync(findChrome(), [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
      '--user-data-dir=' + profile, '--window-size=1280,900',
      '--virtual-time-budget=30000', '--dump-dom', url
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  try { fs.unlinkSync(tmp); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  var m = out.match(/<pre id="__rt_result">([\s\S]*?)<\/pre>/);
  if (!m) return { name: name, text: 'NO RESULT', ok: false, raw: out.slice(-600) };
  var text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  var head = (text.split('\n')[0] || '').trim();
  var mm = head.match(/^RESULT (\d+)\/(\d+)$/);
  return { name: name, text: text, ok: !!(mm && mm[1] === mm[2]) };
}

var cases = [
  { name: '默认关闭', query: '', seed: false, on: false, src: 'default' },
  { name: 'URL 开启', query: '?agentRuntime=1', seed: false, on: true, src: 'url' },
  { name: '设置开启', query: '', seed: true, on: true, src: 'settings' },
  { name: 'URL 覆盖设置关闭', query: '?agentRuntime=0', seed: true, on: false, src: 'url' }
];

var all = true;
cases.forEach(function (c) {
  var r = run(c.name, c.query, c.seed, c.on, c.src);
  console.log('\n== ' + c.name + ' ==');
  console.log(r.text);
  if (r.raw) console.log(r.raw);
  if (!r.ok) all = false;
});
console.log('\nRESULT ' + (all ? 'PASS' : 'FAIL'));
process.exit(all ? 0 : 1);
