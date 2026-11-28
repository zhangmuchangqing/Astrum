'use strict';
/* V2 阶段 C · 学术 Provider 降级与探针语义（离线，mock fetch） */

var path = require('path');
var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
};
require(path.join(__dirname, '..', 'core', 'sources.js'));
var S = globalThis.Sources;

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function res(status, body, headers) {
  var h = headers || {};
  return {
    ok: status >= 200 && status < 300, status: status,
    headers: { get: function (k) { return h[String(k).toLowerCase()] || null; } },
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); }
  };
}
function work(doi, title) {
  return {
    title: title, doi: 'https://doi.org/' + doi,
    concepts: [{ display_name: 'cosmology' }],
    publication_date: '2018-09-01', type: 'article',
    cited_by_count: 100, ids: {},
    authorships: [{ author: { display_name: 'Planck Collaboration' } }],
    primary_location: { source: { display_name: 'Astronomy & Astrophysics' } }
  };
}
function crossrefItem(doi, title) {
  return {
    type: 'journal-article', DOI: doi, URL: 'https://doi.org/' + doi,
    title: [title], 'container-title': ['Astronomy & Astrophysics'],
    author: [{ given: 'A', family: 'Author' }],
    published: { 'date-parts': [[2018, 9, 1]] }, abstract: 'H0 measurement'
  };
}

var calls = [];
var handler = null;
global.fetch = function (url, opts) {
  calls.push({ url: String(url), opts: opts || {} });
  return Promise.resolve(handler(String(url), opts || {}));
};

function oaSearch(url, opts) {
  if (/api\.openalex\.org\/works\/https:\/\/doi\.org\//.test(url)) return res(200, { id: 'probe' });
  if (/api\.openalex\.org\/works\?/.test(url)) {
    if (/429-probe/.test(url)) return res(429, {}, { 'retry-after': '0' });
    if (/dedupe/.test(url)) return res(200, { results: [work('10.9999/d', 'Shared paper')] });
    return res(200, { results: [work('10.1234/x', 'Planck paper')] });
  }
  return null;
}
function crossref(url) {
  if (/api\.crossref\.org\/works\/10\.1051/.test(url)) return res(200, { message: { title: ['probe'] } });
  if (/api\.crossref\.org\/works\?/.test(url)) {
    if (/dedupe/.test(url)) return res(200, { message: { items: [crossrefItem('10.9999/d', 'Shared paper')] } });
    return res(200, { message: { items: [] } });
  }
  return null;
}
function s2(url) {
  if (/paper\/DOI:/.test(url)) return res(200, { title: 'probe' });
  if (/paper\/search/.test(url)) return res(200, { data: [] });
  return null;
}
function arxivFn(url) {
  if (/export\.arxiv\.org/.test(url)) {
    if (/search_query=all:Planck/.test(url)) return res(200, '<feed></feed>');
    return res(200, '<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id>' +
      '<title>Hubble tension review</title><summary>Two sides disagree on H0.</summary>' +
      '<published>2024-01-01T00:00:00Z</published><author><name>A. Author</name></author></entry></feed>');
  }
  return null;
}
function others(url) {
  if (/images-api\.nasa\.gov/.test(url)) return res(200, { collection: { items: [] } });
  if (/api\.wikimedia\.org/.test(url)) return res(200, { pages: [] });
  if (/zh\.wikipedia\.org\/w\/api\.php/.test(url)) return res(200, { query: { search: [] } });
  if (/api\.adsabs\.harvard\.edu/.test(url)) {
    return res(200, { response: { docs: [{
      title: ['ADS paper'], abstract: 'ADS abstract', author: ['B. Author'],
      year: '2020', doi: ['10.5555/ads'], identifier: ['arXiv:2001.00001'], pubdate: '2020-02-01'
    }] } });
  }
  return null;
}
function defaultHandler(url, opts) {
  var r = oaSearch(url, opts) || crossref(url) || s2(url) || arxivFn(url) || others(url);
  return r || res(404, {});
}
function useHandler(fn) { handler = fn || defaultHandler; calls = []; }
function callsTo(re) { return calls.filter(function (c) { return re.test(c.url); }); }

var seq = Promise.resolve();

/* 1. OpenAlex 429 → 按 Retry-After 退避一次后成功 */
seq = seq.then(function () {
  useHandler(function (url, opts) {
    if (/export\.arxiv\.org/.test(url)) return res(200, '<feed></feed>');
    var r = oaSearch(url, opts);
    if (r && /openalex\.org\/works\?/.test(url)) {
      if (callsTo(/openalex\.org\/works\?/).length === 1) return res(429, {}, { 'retry-after': '0' });
      return res(200, { results: [work('10.1234/x', 'Planck paper')] });
    }
    return defaultHandler(url, opts);
  });
  return S.searchMany(['429-probe'], { types: ['paper'], internal: true, skipCache: true, maxCalls: 8 }).then(function (r) {
    eq('429 后仍取得证据', r.items.length, 1);
    eq('429 只重试一次（共 2 次请求）', callsTo(/openalex\.org\/works\?/).length, 2);
    var st = (r.providerStats || []).filter(function (x) { return x.id === 'openalex'; })[0];
    eq('OpenAlex 统计为命中', st && st.state, 'healthy');
  });
});

/* 2. 跨源同 DOI 去重 */
seq = seq.then(function () {
  useHandler(function (url, opts) {
    if (/export\.arxiv\.org/.test(url)) return res(200, '<feed></feed>');
    return defaultHandler(url, opts);
  });
  return S.searchMany(['dedupe'], { types: ['paper'], internal: true, skipCache: true, maxCalls: 8 }).then(function (r) {
    eq('同 DOI 只保留一条', r.items.length, 1);
    ok('记录重复数', r.duplicates >= 1, 'duplicates=' + r.duplicates);
    var stats = r.providerStats || [];
    var cr = stats.filter(function (x) { return x.id === 'crossref'; })[0];
    var oa = stats.filter(function (x) { return x.id === 'openalex'; })[0];
    eq('两源合计只贡献一条', (cr ? cr.contributed : 0) + (oa ? oa.contributed : 0), 1);
  });
});

/* 3. arXiv Atom 解析 */
seq = seq.then(function () {
  useHandler(function (url, opts) {
    if (/openalex\.org\/works\?/.test(url)) return res(200, { results: [] });
    if (/crossref\.org\/works\?/.test(url)) return res(200, { message: { items: [] } });
    if (/semanticscholar/.test(url)) return res(200, { data: [] });
    return defaultHandler(url, opts);
  });
  return S.searchMany(['arxiv test'], { types: ['paper'], internal: true, skipCache: true, maxCalls: 10 }).then(function (r) {
    eq('arXiv 返回一条', r.items.length, 1);
    var it = r.items[0] || {};
    eq('arXiv 来源类型', it.sourceType, 'paper');
    eq('arXiv 编号', it.extra && it.extra.arxivId, '2401.00001v1');
    ok('arXiv 标记预印本', it.version === 'preprint');
  });
});

/* 4. 探针：连通性 ≠ 检索命中；ADS 无 Token → unavailable */
seq = seq.then(function () {
  useHandler();
  return S.diagnose().then(function (list) {
    var by = {};
    list.forEach(function (x) { by[x.id] = x; });
    eq('Crossref 探针判定可用', by.crossref.state, 'healthy');
    eq('Crossref 探针 ok', by.crossref.ok, true);
    eq('arXiv 探测无命中但服务可用', by.arxiv.state, 'no_results');
    eq('ADS 未配置判定 unavailable', by.ads.state, 'unavailable');
    eq('ADS 未配置不发起请求', callsTo(/adsabs/).length, 0);
    ok('Semantic Scholar 探针状态可解释',
      ['healthy', 'cooling'].indexOf(by.semanticscholar.state) >= 0,
      'got=' + by.semanticscholar.state);
    ok('每条探针都有 state/msg', list.every(function (x) { return !!x.state && typeof x.msg === 'string'; }));
  });
});

/* 5. Crossref 检索 0 命中：providerStats 记为 no_results，而不是 failed */
seq = seq.then(function () {
  useHandler(function (url, opts) {
    if (/api\.crossref\.org\/works\?/.test(url)) return res(200, { message: { items: [] } });
    if (/openalex\.org\/works\?/.test(url)) return res(200, { results: [] });
    if (/semanticscholar|export\.arxiv\.org/.test(url)) return /export\.arxiv\.org/.test(url) ? res(200, '<feed></feed>') : res(200, { data: [] });
    return others(url) || res(404, {});
  });
  return S.searchMany(['empty query test'], { types: ['paper'], internal: true, skipCache: true, maxCalls: 10 }).then(function (r) {
    var cr = (r.providerStats || []).filter(function (x) { return x.id === 'crossref'; })[0];
    eq('Crossref 0 命中记 no_results', cr && cr.state, 'no_results');
    ok('0 命中不记为 failed', !(cr && cr.state === 'failed'));
  });
});

/* 6. 配置 ADS Token 后：进入检索链并携带 Bearer */
seq = seq.then(function () {
  S.setConfig('ads', { token: 'secret-token' });
  useHandler();
  return S.searchMany(['ads query'], { types: ['paper'], internal: true, skipCache: true, maxCalls: 12 }).then(function (r) {
    var hit = r.items.filter(function (x) { return x.host === 'ui.adsabs.harvard.edu'; })[0];
    ok('ADS 配置后参与检索', !!hit, 'items=' + r.items.length);
    var call = callsTo(/adsabs/)[0];
    ok('ADS 请求携带 Bearer', !!(call && call.opts.headers && call.opts.headers.Authorization === 'Bearer secret-token'));
    return S.diagnose().then(function (list) {
      var ads = list.filter(function (x) { return x.id === 'ads'; })[0];
      eq('ADS 配置后探针可用', ads.state, 'healthy');
    });
  }).then(function () { S.setConfig('ads', { token: '' }); });
});

seq.then(function () {
  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  if (failed) { console.log('失败项：' + failures.join('、')); process.exit(1); }
}).catch(function (e) {
  console.log('  FAIL 未捕获异常 :: ' + (e && e.stack || e));
  process.exit(1);
});
