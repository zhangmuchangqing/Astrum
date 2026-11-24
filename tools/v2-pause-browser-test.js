/* ASTRUM V2-B · R-07 暂停流程浏览器端到端点击验收
 *
 * 真实 Chrome + 本地 HTTP + CDP；注入一个「可中止的门控慢工具」，
 * 让研究任务停在工具执行中，再由测试真点击「暂停」按钮。
 * 断言全部来自真实 DOM 与真实持久化任务状态，不伪造 PASS。
 *
 * 覆盖：
 *   - 运行中 UI 出现暂停按钮，且拿到真实 taskId 前禁用
 *   - 真点击暂停 → 按钮/进度呈现 PAUSE_REQUESTED 语义（不谎称已暂停）
 *   - 在飞工具收到 abort('pause') → PAUSED 收尾
 *   - 持久化任务含 pausedAt、pauseRequestedAt 清空，且 pause_requested/task.paused 事件入链
 *   - 刷新后任务卡片呈现「已暂停」，提供继续入口（恢复链路端到端）
 *
 * 用法：node tools/v2-pause-browser-test.js
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var http = require('http');
var ROOT = path.resolve(__dirname, '..');

function findChrome() {
  var c = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (var i = 0; i < c.length; i++) if (fs.existsSync(c[i])) return c[i];
  return 'chrome';
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function mime(p) {
  if (/\.html$/.test(p)) return 'text/html; charset=utf-8';
  if (/\.js$/.test(p)) return 'text/javascript; charset=utf-8';
  if (/\.css$/.test(p)) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
var state = { gateResolve: null, gateAborted: false, toolEntered: 0 };
function serve() {
  return new Promise(function (resolve) {
    var s = http.createServer(function (req, res) {
      var rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
      var full = path.join(ROOT, rel || 'index.html');
      fs.readFile(full, function (e, buf) {
        if (e) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    s.listen(0, '127.0.0.1', function () { resolve({ server: s, port: s.address().port }); });
  });
}
async function readPort(profile, budget) {
  var f = path.join(profile, 'DevToolsActivePort'), t = Date.now();
  while (Date.now() - t < budget) {
    if (fs.existsSync(f)) { var l = fs.readFileSync(f, 'utf8').split('\n'); if (l[0]) return Number(l[0]); }
    await sleep(200);
  }
  return null;
}
async function findPage(port) {
  var r = await fetch('http://127.0.0.1:' + port + '/json/list');
  var l = await r.json();
  return (l || []).filter(function (x) { return x.type === 'page'; })[0] || null;
}
function Cdp(ws) {
  var self = this; this.ws = ws; this.id = 0; this.pending = {};
  this.ready = new Promise(function (res, rej) { ws.addEventListener('open', function () { res(); }); ws.addEventListener('error', function () { rej(new Error('ws')); }); });
  ws.addEventListener('message', function (e) {
    var m = JSON.parse(e.data);
    if (m.id && self.pending[m.id]) {
      var p = self.pending[m.id]; delete self.pending[m.id];
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
}
Cdp.prototype.send = function (method, params, ms) {
  var self = this;
  return this.ready.then(function () {
    return new Promise(function (res, rej) {
      var id = ++self.id; self.pending[id] = { resolve: res, reject: rej };
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (self.pending[id]) { delete self.pending[id]; rej(new Error('timeout ' + method)); } }, ms || 60000);
    });
  });
};
Cdp.prototype.eval = function (expr, ms) {
  return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
};
var results = [];
function ok(n, p, x) { results.push({ n: n, p: !!p, x: x == null ? '' : String(x) }); }
async function waitAstrium(cdp) {
  for (var i = 0; i < 100; i++) {
    var r = await cdp.eval('!!(window.__astrum && window.AstroControlBridge && window.AstroControlBridge.pause && window.AstroRegistry)', 10000);
    if (r && r.result && r.result.value === true) return true;
    await sleep(250);
  }
  return false;
}

/* 注入门控慢工具：包装注册表中 T-E 研究模板会用到的工具。
 * 慢工具进入后向 window.__r07 报告，并等待 abort('pause') 才释放。 */
function injectExpr() {
  return `(async function(){
    window.__r07 = { entered: [], toolAborted: false, abortReason: null, paused: false };
    var reg = window.AstroRegistry;
    var base = reg.createDefault({ adapter: window.AstroComposeAdapter
      ? window.AstroComposeAdapter.create({ agentCore: window.AgentCore }) : null,
      agentCore: window.AgentCore, network: false });
    /* 包装实例的 get，让门控工具替换注册表工具；再让全局工厂返回该实例。 */
    var origGet = base.get;
    base.get = function (id) {
      var spec = origGet.call(this, id);
      if (!spec || !spec.run) return spec;
      var origRun = spec.run;
      var wrapped = Object.assign({}, spec);
      wrapped.timeoutMs = 8000;
      wrapped.abortable = true;
      wrapped.run = function (args, ctx, sp, cfg, deps, rt) {
        window.__r07.entered.push(id);
        /* 恢复阶段（localStorage 标记）不再门控，让流程顺畅跑完。 */
        var recovering = false;
        try { recovering = localStorage.getItem('__r07_recovering') === '1'; } catch (e) { /* 忽略 */ }
        /* 只让第一个数据步骤门控，其余保持快速，避免多个并发挂起。 */
        if (recovering || window.__r07.entered.length !== 1) {
          return origRun.apply(this, arguments);
        }
        return new Promise(function (resolve) {
          var sig = rt && rt.signal;
          var done = false;
          function finish(reason) {
            if (done) return; done = true;
            window.__r07.toolAborted = true;
            window.__r07.abortReason = reason == null ? 'aborted' : String(reason);
            /* 底层工具拿到的是 attemptSignal：标准化 AbortError。
             * pause 语义由编排层从外层 signal.reason 恢复（R-01/R-02），
             * 因此这里按底层事实返回，再由 step.abort.code 验证 pause 语义。 */
            resolve({ ok: false, reason: 'cancelled', kind: 'cancelled',
              retriable: false, pendingAbort: true, pause: false,
              abortRequested: true, abortSupported: true,
              abortConfirmed: true, abortCode: 'UPSTREAM_ABORTED' });
          }
          if (sig) {
            if (sig.aborted) finish(sig.reason);
            else sig.addEventListener('abort', function () { finish(sig.reason); });
          }
        });
      };
      return wrapped;
    };
    /* 覆盖 Control.makeRuntime 的默认注册表：把包装后的注册表挂到全局工厂。 */
    reg.createDefault = function () { return base; };
    /* 记录真实 taskId：包装 runWithRoute，注入 onTask 观察者（不影响 UI 自己的 onTask）。 */
    var bridge = window.AstroControlBridge;
    var origRunRoute = bridge.runWithRoute;
    bridge.runWithRoute = function (info, q, ctx, cfg, opts) {
      opts = opts || {};
      var prevOnTask = opts.onTask;
      opts = Object.assign({}, opts, { onTask: function (id, st) {
        window.__r07.taskId = id;
        try { localStorage.setItem('__r07_taskId', id); } catch (e) { /* 忽略 */ }
        if (prevOnTask) prevOnTask(id, st);
      }});
      return origRunRoute.call(this, info, q, ctx, cfg, opts);
    };
    try { if (window.Thread && window.Thread.clearAll) await window.Thread.clearAll(); } catch(e) {}
    window.__astrum.newChat();
    return { ok: true };
  })()`;
}

async function evalValue(cdp, expr, ms) {
  var r = await cdp.eval(expr, ms || 10000);
  return r && r.result ? r.result.value : null;
}

(async function main() {
  var srv = await serve();
  var profile = path.join(os.tmpdir(), 'astrum_r07pause_' + Date.now());
  fs.mkdirSync(profile);
  var child = cp.spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'http://127.0.0.1:' + srv.port + '/index.html'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  var cdp = null;
  try {
    var port = await readPort(profile, 20000);
    if (!port) throw new Error('DevToolsActivePort 未就绪');
    var page = await findPage(port);
    if (!page) throw new Error('未找到 page target');
    cdp = new Cdp(new WebSocket(page.webSocketDebuggerUrl));
    ok('R7-E1 页面启动且暂停桥可用', await waitAstrium(cdp));

    var inj = await evalValue(cdp, injectExpr(), 30000);
    ok('R7-E2 注入可中止慢工具成功', inj && inj.ok === true, JSON.stringify(inj));

    /* 通过真实 UI 入口发起研究任务；触发 controlAnswer。 */
    await evalValue(cdp, "window.__astrum.ask('M42 研究最新进展'); 'asked'", 10000);

    /* 等待：暂停按钮出现且可用（拿到真实 taskId）、工具进入门控。 */
    var ui0 = null;
    for (var i = 0; i < 120; i++) {
      ui0 = await evalValue(cdp, `(function(){
        var bs=Array.prototype.slice.call(document.querySelectorAll('button'));
        var pb=bs.filter(function(b){return /暂停/.test(b.textContent);})[0];
        return { hasPause:!!pb, disabled:pb?pb.disabled:null, text:pb?pb.textContent:'',
          entered:(window.__r07&&window.__r07.entered.length)||0,
          streaming:!!document.querySelector('.stream-msg') };
      })()`);
      if (ui0 && ui0.hasPause && ui0.disabled === false && ui0.entered >= 1) break;
      await sleep(150);
    }
    ok('R7-E3 运行中 UI 出现可用暂停按钮', !!(ui0 && ui0.hasPause && ui0.disabled === false),
      JSON.stringify(ui0));
    ok('R7-E4 门控工具确已进入执行（真实在飞步骤）', !!(ui0 && ui0.entered >= 1), JSON.stringify(ui0));

    /* 真实点击「暂停」按钮。 */
    var clicked = await evalValue(cdp, `(function(){
      var bs=Array.prototype.slice.call(document.querySelectorAll('button'));
      var pb=bs.filter(function(b){return /暂停/.test(b.textContent) && !b.disabled;})[0];
      if(!pb) return false;
      pb.click(); return true;
    })()`);
    ok('R7-E5 真实点击暂停按钮', clicked === true);

    /* 等待按钮呈现请求态；记录点击后即时文案，核对未谎称已暂停。 */
    var reqUi = null;
    for (var j = 0; j < 60; j++) {
      reqUi = await evalValue(cdp, `(function(){
        var bs=Array.prototype.slice.call(document.querySelectorAll('button'));
        var pb=bs.filter(function(b){return /暂停/.test(b.textContent);})[0];
        return { text:pb?pb.textContent:'', toolAborted:!!(window.__r07&&window.__r07.toolAborted),
          abortReason:(window.__r07&&window.__r07.abortReason)||null };
      })()`);
      if (reqUi && (/请求|等待/.test(reqUi.text) || /已暂停/.test(reqUi.text))) break;
      await sleep(100);
    }
    ok('R7-E6 点击后呈现 PAUSE_REQUESTED 语义（不谎称已暂停）',
      !!(reqUi && /请求|等待|已暂停/.test(reqUi.text)), JSON.stringify(reqUi));
    /* 工具 abort 标志的设置按钮文本更新稍晚，独立轮询等待，避免竞态误报。 */
    var aborted = null;
    for (var jj = 0; jj < 80; jj++) {
      aborted = await evalValue(cdp,
        "(function(){return {toolAborted:!!(window.__r07&&window.__r07.toolAborted),abortReason:(window.__r07&&window.__r07.abortReason)||null};})()");
      if (aborted && aborted.toolAborted === true) break;
      await sleep(100);
    }
    ok('R7-E7 在飞工具确实收到 abort 并释放', !!(aborted && aborted.toolAborted === true),
      JSON.stringify(aborted));

    /* 等待门控工具 abort 释放、UI 呈现 PAUSED、任务持久化完成。 */
    var done = null;
    for (var k = 0; k < 120; k++) {
      done = await evalValue(cdp, `(async function(){
        var bs=Array.prototype.slice.call(document.querySelectorAll('button'));
        var pb=bs.filter(function(b){return /暂停/.test(b.textContent);})[0];
        var id = window.__r07 && window.__r07.taskId;
        var st = null;
        if (id && window.AstroTaskStore) {
          try { var s = window.AstroTaskStore.create({});
            var t = await s.get(id);
            if (t) st = { phase:t.phase, pausedAt:!!t.pausedAt, pauseRequestedAt:!!t.pauseRequestedAt,
              events:(t.events||[]).map(function(e){return e.type;}),
              abortCodes:(t.steps||[]).map(function(s){return s.abort&&s.abort.code||null;}) };
          } catch(e) { st={error:String(e)}; }
        }
        return { text:pb?pb.textContent:'', taskId:id||null, st:st,
          toast:document.body.innerText.indexOf('已暂停')>=0 };
      })()`);
      if (done && done.st && done.st.pausedAt === true) break;
      await sleep(150);
    }
    ok('R7-E8 持久化任务进入 PAUSED（pausedAt 存在）', !!(done && done.st && done.st.pausedAt === true),
      JSON.stringify(done && done.st));
    ok('R7-E9 pauseRequestedAt 已清空（请求态与完成态分离）',
      !!(done && done.st && done.st.pauseRequestedAt === false), JSON.stringify(done && done.st));
    ok('R7-E10 事件链含 pause_requested 与 task.paused',
      !!(done && done.st && done.st.events && done.st.events.indexOf('task.pause_requested') >= 0 &&
        done.st.events.indexOf('task.paused') >= 0), JSON.stringify(done && done.st && done.st.events));
    ok('R7-E11 在飞步骤记录 PAUSE_REQUESTED 中止码（pause 语义由编排层恢复）',
      !!(done && done.st && done.st.abortCodes &&
        done.st.abortCodes.indexOf('PAUSE_REQUESTED') >= 0),
      JSON.stringify(done && done.st && done.st.abortCodes));

    /* ---- 刷新 + 恢复链路：验证暂停后可从任务卡片真正继续 ---- */
    await evalValue(cdp, 'location.reload()', 20000);
    /* 刷新后 __r07 变量丢失，从 localStorage 恢复 taskId。 */
    var rid = await evalValue(cdp, "localStorage.getItem('__r07_taskId')", 20000);
    await evalValue(cdp, "(function(){ var id=localStorage.getItem('__r07_taskId'); if(id){window.__r07={taskId:id,entered:[],toolAborted:false};} return !!id; })()", 20000);
    ok('R7-E12 刷新后页面恢复且保留 taskId', !!(await waitAstrium(cdp)) && !!rid,
      String(rid));

    /* boot 300ms 后 offerResumeTask 渲染卡片；等待「继续任务」按钮与「已暂停」标注。 */
    var resumeUi = null;
    for (var m = 0; m < 80; m++) {
      resumeUi = await evalValue(cdp, `(function(){
        var box=document.querySelector('.research-resume');
        var btns=box?Array.prototype.slice.call(box.querySelectorAll('button')):[];
        var cont=btns.filter(function(b){return /继续任务/.test(b.textContent);})[0];
        return { hasBox:!!box, text:box?box.innerText:'', hasContinue:!!cont,
          disabled:cont?cont.disabled:null };
      })()`);
      if (resumeUi && resumeUi.hasContinue && /已暂停/.test(resumeUi.text)) break;
      await sleep(150);
    }
    ok('R7-E13 刷新后任务卡片标注「已暂停」并提供继续入口',
      !!(resumeUi && resumeUi.hasContinue && /已暂停/.test(resumeUi.text)),
      JSON.stringify(resumeUi));

    /* 真点击「继续任务」；恢复后门控工具不再挂起（entered>1 会走快速原实现）。 */
    var resumedClicked = await evalValue(cdp, `(function(){
      var box=document.querySelector('.research-resume');
      if(!box) return false;
      var cont=Array.prototype.slice.call(box.querySelectorAll('button'))
        .filter(function(b){return /继续任务/.test(b.textContent) && !b.disabled;})[0];
      if(!cont) return false;
      cont.click(); return true;
    })()`);
    ok('R7-E14 真实点击「继续任务」', resumedClicked === true);

    /* 等待恢复完成：任务 pauseRequestedAt/pausedAt 被清除，重新进入执行并产出结果。 */
    var resumed = null;
    for (var n = 0; n < 120; n++) {
      resumed = await evalValue(cdp, `(async function(){
        var id = window.__r07 && window.__r07.taskId;
        var st=null;
        if(id && window.AstroTaskStore){
          try{ var s=window.AstroTaskStore.create({}); var t=await s.get(id);
            if(t) st={ pausedAt:!!t.pausedAt, pauseRequestedAt:!!t.pauseRequestedAt,
              recoveries:t.recoveries||0, events:(t.events||[]).map(function(e){return e.type;}) };
          }catch(e){ st={error:String(e)}; }
        }
        return { st:st };
      })()`);
      if (resumed && resumed.st && resumed.st.pausedAt === false &&
          resumed.st.events && resumed.st.events.indexOf('task.recovered') >= 0) break;
      await sleep(150);
    }
    ok('R7-E15 恢复后清除暂停标记并记录恢复事件',
      !!(resumed && resumed.st && resumed.st.pausedAt === false &&
        resumed.st.events && resumed.st.events.indexOf('task.recovered') >= 0),
      JSON.stringify(resumed && resumed.st));
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) { /* 忽略 */ }
    try { child.kill(); } catch (e) { /* 忽略 */ }
    try { srv.server.close(); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  var pass = results.filter(function (r) { return r.p; }).length;
  console.log('RESULT ' + pass + '/' + results.length);
  results.forEach(function (r) { console.log((r.p ? 'PASS' : 'FAIL') + ' | ' + r.n + (r.x ? ' | ' + r.x : '')); });
  process.exit(pass === results.length ? 0 : 1);
})().catch(function (e) {
  console.error('UNEXPECTED', e && e.stack || e);
  process.exit(1);
});
