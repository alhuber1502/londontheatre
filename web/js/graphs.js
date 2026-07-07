/* London Stage, 1660-1800 — network graphs view
   Six modes (per decade or all-eras): theatre↔performer, co-casting, programme
   pairings, work↔performer, full ecosystem, venue competition.
   Uses graphology + sigma 3 via ESM. Layout: ForceAtlas2 (linLog) + noverlap. */

import Graph from 'https://esm.sh/graphology@0.25.4';
import Sigma from 'https://esm.sh/sigma@3.0.0';
import forceAtlas2 from 'https://esm.sh/graphology-layout-forceatlas2@0.10.1';
import noverlap from 'https://esm.sh/graphology-layout-noverlap@0.4.2';

// ---- node/edge colours -------------------------------------------------------
var C = {
  theatre:    '#7a2e1f',   // brick
  performer:  '#2a1f14',   // ink (light mode)
  perfDark:   '#d9c9a8',   // ink-soft (dark mode)
  mainpiece:  '#6b4e1c',   // warm brown
  afterpiece: '#b5821a',   // amber/gold
  edge:       'rgba(90,70,50,0.22)',
  edgeDark:   'rgba(140,115,75,0.08)'
};

// ---- limits ------------------------------------------------------------------
var MAX_PERF_TP   = 130;   // theatre-performer: top performers
var MIN_TP_W      = 5;     // theatre-performer: min edge weight (×8 for all-eras)
var MAX_PERF_PP   = 80;    // co-casting: top performers (by edge score)
var MAX_PP_EDGES  = 450;   // co-casting: max edges
var MIN_PP_W      = 3;     // co-casting: min edge weight
var MAX_MAIN_PA   = 60;    // pairings: mainpieces
var MAX_AFT_PA    = 50;    // pairings: afterpieces
var MIN_PA_W      = 3;     // pairings: min edge weight
var MAX_WORK_WP   = 80;    // work-performer: top works
var MAX_PERF_WP   = 100;   // work-performer: top performers
var MIN_WP_W      = 3;     // work-performer: min edge weight
var MAX_PERF_ECO  = 50;    // ecosystem: top performers
var MAX_WORK_ECO  = 50;    // ecosystem: top works
var MIN_VEN_W     = 5;     // venue competition: min shared performers
var FA2_ITERS     = 300;   // FA2 layout iterations

// ---- state -------------------------------------------------------------------
var currentDecade = 'all';
var currentMode   = 'theatres';
var sigmaRenderer = null;
var decadeCache   = {};
var abbrCache     = null;

// ---- fetch helpers -----------------------------------------------------------
function fetchJSON(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
    return r.json();
  });
}

function fetchDecade(d) {
  if (decadeCache[d]) return Promise.resolve(decadeCache[d]);
  return fetchJSON('data/graphs/' + d + '.json').then(function (doc) {
    decadeCache[d] = doc;
    return doc;
  });
}

function fetchAbbr() {
  if (abbrCache) return Promise.resolve(abbrCache);
  return fetchJSON('data/theatre-abbreviations.json').then(function (a) {
    abbrCache = a;
    return a;
  }).catch(function () {
    abbrCache = {};
    return abbrCache;
  });
}

function theatreName(code, abbr) {
  var key = String(code).toLowerCase().replace(/\s+/g, '');
  if (key === 'none') return 'Unknown Venue';
  if (abbr) {
    var entry = (abbr.entries && abbr.entries[key]) || (abbr.compound && abbr.compound[key]);
    if (entry && entry.canonical) return entry.canonical;
  }
  return code.toUpperCase();
}

// ---- layout helpers ----------------------------------------------------------

// Compress layout to a target radius so the camera zoom starts consistently.
function normaliseLayout(g) {
  var n = g.order;
  if (!n) return;
  var maxR = 0;
  g.forEachNode(function (node, attrs) {
    var r = Math.sqrt(attrs.x * attrs.x + attrs.y * attrs.y);
    if (r > maxR) maxR = r;
  });
  var targetR = Math.max(80, Math.sqrt(n) * 38);
  if (maxR > 0 && maxR > targetR) {
    var s = targetR / maxR;
    g.forEachNode(function (node, attrs) {
      g.setNodeAttribute(node, 'x', attrs.x * s);
      g.setNodeAttribute(node, 'y', attrs.y * s);
    });
  }
}

// Circular layout — nodes evenly spaced on a ring, ordered by insertion order
// (callers should add nodes sorted by score so connected performers sit close).
// Works well for dense single-type graphs where force layouts produce hairballs.
function layoutCircular(g) {
  var nodes = g.nodes();
  var n = nodes.length;
  if (n < 2) return;
  var r = Math.max(80, Math.sqrt(n) * 38);
  nodes.forEach(function (node, i) {
    var angle = (2 * Math.PI * i / n) - Math.PI / 2;
    g.setNodeAttribute(node, 'x', r * Math.cos(angle));
    g.setNodeAttribute(node, 'y', r * Math.sin(angle));
  });
}

// ForceAtlas2 (linLog, strong repulsion) + noverlap post-pass.
// Used for graphs where both node types are the same (co-casting, venues).
function layoutFA2(g) {
  var n = g.order;
  if (n < 2) return;
  var scale = Math.max(200, Math.sqrt(n) * 55);
  g.forEachNode(function (node) {
    g.setNodeAttribute(node, 'x', (Math.random() - 0.5) * scale);
    g.setNodeAttribute(node, 'y', (Math.random() - 0.5) * scale);
  });
  forceAtlas2.assign(g, {
    iterations: FA2_ITERS,
    settings: {
      linLog:            true,
      gravity:           0.5,
      scalingRatio:      10,
      slowDown:          1,
      barnesHutOptimize: n > 100
    }
  });
  noverlap.assign(g, {
    maxIterations: 100,
    settings: { ratio: 1.1, speed: 3, margin: 2 }
  });
  normaliseLayout(g);
}

// Two-column bipartite layout. isLeft(node, attrs) → true for left column.
// Nodes sorted by size within each column; small x-jitter for visual depth.
function layoutBipartite(g, isLeft) {
  var left = [], right = [];
  g.forEachNode(function (node, attrs) {
    (isLeft(node, attrs) ? left : right).push({ node: node, size: attrs.size || 5 });
  });
  left.sort(function (a, b) { return b.size - a.size; });
  right.sort(function (a, b) { return b.size - a.size; });

  var nMax = Math.max(left.length, right.length, 1);
  var colX = Math.max(150, nMax * 9);
  var gap  = 8;

  function placeCol(nodes, x) {
    if (!nodes.length) return;
    var totalH = nodes.reduce(function (s, nd) { return s + nd.size * 2 + gap; }, -gap);
    var y = -totalH / 2;
    nodes.forEach(function (item) {
      y += item.size;
      g.setNodeAttribute(item.node, 'x', x + (Math.random() - 0.5) * colX * 0.08);
      g.setNodeAttribute(item.node, 'y', y);
      y += item.size + gap;
    });
  }

  placeCol(left,  -colX);
  placeCol(right,  colX);
  normaliseLayout(g);
}

// Three-column layout. getGroup(node, attrs) → 'left' | 'mid' | 'right'.
function layoutTripartite(g, getGroup) {
  var cols = { left: [], mid: [], right: [] };
  g.forEachNode(function (node, attrs) {
    var grp = getGroup(node, attrs);
    (cols[grp] || cols.mid).push({ node: node, size: attrs.size || 5 });
  });
  Object.keys(cols).forEach(function (k) {
    cols[k].sort(function (a, b) { return b.size - a.size; });
  });

  var nMax = Math.max(cols.left.length, cols.mid.length, cols.right.length, 1);
  var colX = Math.max(150, nMax * 9);
  var gap  = 8;

  function placeCol(nodes, x) {
    if (!nodes.length) return;
    var totalH = nodes.reduce(function (s, nd) { return s + nd.size * 2 + gap; }, -gap);
    var y = -totalH / 2;
    nodes.forEach(function (item) {
      y += item.size;
      g.setNodeAttribute(item.node, 'x', x + (Math.random() - 0.5) * colX * 0.08);
      g.setNodeAttribute(item.node, 'y', y);
      y += item.size + gap;
    });
  }

  placeCol(cols.left,  -colX);
  placeCol(cols.mid,    0);
  placeCol(cols.right,  colX);
  normaliseLayout(g);
}

// ---- helpers -----------------------------------------------------------------
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

function nodeColor(type) {
  if (type === 'theatre')   return C.theatre;
  if (type === 'mainpiece') return C.mainpiece;
  if (type === 'afterpiece')return C.afterpiece;
  return isDark() ? C.perfDark : C.performer;
}

function edgeColor() {
  return isDark() ? C.edgeDark : C.edge;
}

// ---- graph builders ----------------------------------------------------------

// Number of guaranteed top-performer edges per theatre. Ensures every theatre
// with any cast survives the global threshold so niche/short-lived venues
// (Vere Street, Red Bull, court performances, fairs) don't drop out of the
// view. The major theatres still surface their broader rosters through the
// global MIN_TP_W cutoff layered on top.
var GUARANTEED_PER_THEATRE = 3;

function buildTheatreGraph(data, abbr) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allPerf = data.nodes.performers;

  // Pass 1: collect each theatre's top performers by local edge weight.
  // These edges are guaranteed-visible regardless of the global threshold.
  var topByTheatre = new Map();   // tIdx -> [{ pIdx, w }]
  data.edges.theatrePerformer.forEach(function (e) {
    var arr = topByTheatre.get(e[0]);
    if (!arr) { arr = []; topByTheatre.set(e[0], arr); }
    arr.push({ pIdx: e[1], w: e[2] });
  });
  var guaranteedEdge = {}; // "tIdx_pIdx" -> true
  topByTheatre.forEach(function (arr, tIdx) {
    arr.sort(function (a, b) { return b.w - a.w; });
    arr.slice(0, GUARANTEED_PER_THEATRE).forEach(function (e) {
      guaranteedEdge[tIdx + '_' + e.pIdx] = true;
    });
  });

  // Global top-N performers by total appearances (unchanged).
  var ranked  = allPerf.map(function (p, i) { return { i: i, id: p.id, count: p.count }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, MAX_PERF_TP);
  // visible = global top-N ∪ guaranteed (any performer who is someone's local top-K).
  var visible = {};
  ranked.forEach(function (p) { visible[p.i] = p; });
  Object.keys(guaranteedEdge).forEach(function (k) {
    var pIdx = +k.split('_')[1];
    if (!visible[pIdx]) {
      visible[pIdx] = { i: pIdx, id: allPerf[pIdx].id, count: allPerf[pIdx].count };
    }
  });

  // Pass 2: mark which theatres / performers will actually be rendered. A
  // theatre / performer is shown if it participates in at least one edge
  // that passes either the global threshold or the per-theatre guarantee.
  var tpMinW = currentDecade === 'all' ? MIN_TP_W * 8 : MIN_TP_W;
  var connT = {}, connP = {};
  data.edges.theatrePerformer.forEach(function (e) {
    if (!visible[e[1]]) return;
    var isGuaranteed = guaranteedEdge[e[0] + '_' + e[1]];
    if (isGuaranteed || e[2] >= tpMinW) {
      connT[e[0]] = true;
      connP[e[1]] = true;
    }
  });

  // Drop the "none" sentinel — it's a placeholder for un-attributed venues,
  // not a real playhouse, and would otherwise gain edges from the fallback.
  data.nodes.theatres.forEach(function (t, i) {
    if (t.id === 'none') connT[i] = false;
  });

  var maxTCount = 1, maxPCount = 1;
  data.nodes.theatres.forEach(function (t, i) {
    if (connT[i] && t.count > maxTCount) maxTCount = t.count;
  });
  Object.keys(visible).forEach(function (pi) {
    var p = visible[pi];
    if (connP[p.i] && p.count > maxPCount) maxPCount = p.count;
  });

  var ln = [], nm = {};

  data.nodes.theatres.forEach(function (t, i) {
    if (!connT[i]) return;
    var sid = 't' + i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: theatreName(t.id, abbr),
      size: 6 + 22 * Math.sqrt(t.count / maxTCount),
      color: nodeColor('theatre'),
      nodeType: 'theatre', entityId: t.id, count: t.count, x: 0, y: 0
    });
  });

  Object.keys(visible).forEach(function (pi) {
    var p = visible[pi];
    if (!connP[p.i]) return;
    var sid = 'p' + p.i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: p.id,
      size: 2 + 10 * Math.sqrt(p.count / maxPCount),
      color: nodeColor('performer'),
      nodeType: 'performer', entityId: p.id, count: p.count, x: 0, y: 0
    });
  });

  var le = [], ec = edgeColor();
  data.edges.theatrePerformer.forEach(function (e) {
    if (!visible[e[1]]) return;
    var isGuaranteed = guaranteedEdge[e[0] + '_' + e[1]];
    if (!isGuaranteed && e[2] < tpMinW) return;
    var ts = 't' + e[0], ps = 'p' + e[1];
    if (!g.hasNode(ts) || !g.hasNode(ps) || g.hasEdge(ts, ps)) return;
    le.push([nm[ts], nm[ps]]);
    g.addEdge(ts, ps, { size: Math.max(0.5, Math.min(3, Math.log(e[2] + 1) * 0.6)), color: ec });
  });

  layoutBipartite(g, function (node, attrs) { return attrs.nodeType === 'theatre'; });

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

function buildCastingGraph(data) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allPerf  = data.nodes.performers;
  var score    = new Float64Array(allPerf.length);
  data.edges.performerPerformer.forEach(function (e) {
    if (e[2] >= MIN_PP_W) { score[e[0]] += e[2]; score[e[1]] += e[2]; }
  });

  var ranked = allPerf
    .map(function (p, i) { return { i: i, id: p.id, count: p.count, score: score[i] }; })
    .filter(function (p) { return p.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_PERF_PP);
  var visible = {};
  ranked.forEach(function (p) { visible[p.i] = p; });

  var eligible = data.edges.performerPerformer
    .filter(function (e) { return e[2] >= MIN_PP_W && visible[e[0]] && visible[e[1]]; })
    .sort(function (a, b) { return b[2] - a[2]; })
    .slice(0, MAX_PP_EDGES);

  var connP = {};
  eligible.forEach(function (e) { connP[e[0]] = true; connP[e[1]] = true; });

  var maxScore = 1;
  ranked.forEach(function (p) { if (connP[p.i] && p.score > maxScore) maxScore = p.score; });

  var ln = [], nm = {};
  ranked.forEach(function (p) {
    if (!connP[p.i]) return;
    var sid = 'p' + p.i;
    var sz  = 3 + 17 * Math.sqrt(p.score / maxScore);
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: p.id, size: sz, color: nodeColor('performer'),
      nodeType: 'performer', entityId: p.id, count: p.count, x: 0, y: 0
    });
  });

  var le = [], ec = edgeColor();
  eligible.forEach(function (e) {
    var as = 'p' + e[0], bs = 'p' + e[1];
    if (!g.hasNode(as) || !g.hasNode(bs) || g.hasEdge(as, bs)) return;
    le.push([nm[as], nm[bs]]);
    g.addEdge(as, bs, { size: Math.max(0.5, Math.min(3.5, Math.log(e[2]) * 0.7)), color: ec });
  });

  layoutCircular(g);

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

function buildPairingsGraph(data) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allWorks = data.nodes.works;
  var wScore   = new Float64Array(allWorks.length);
  data.edges.mainAfterpiece.forEach(function (e) {
    wScore[e[0]] += e[2]; wScore[e[1]] += e[2];
  });

  var mainpieces = allWorks
    .map(function (w, i) { return { i: i, id: w.id, title: w.title || w.id, ptype: w.ptype, count: w.count, score: wScore[i] }; })
    .filter(function (w) { return w.ptype === 'p' && w.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_MAIN_PA);

  var afterpieces = allWorks
    .map(function (w, i) { return { i: i, id: w.id, title: w.title || w.id, ptype: w.ptype, count: w.count, score: wScore[i] }; })
    .filter(function (w) { return w.ptype === 'a' && w.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_AFT_PA);

  var visible = {};
  mainpieces.forEach(function (w) { visible[w.i] = w; });
  afterpieces.forEach(function (w) { visible[w.i] = w; });

  var eligible = data.edges.mainAfterpiece
    .filter(function (e) { return e[2] >= MIN_PA_W && visible[e[0]] && visible[e[1]]; })
    .sort(function (a, b) { return b[2] - a[2]; });

  var connW = {};
  eligible.forEach(function (e) { connW[e[0]] = true; connW[e[1]] = true; });

  var maxWScore = 1;
  mainpieces.forEach(function (w) { if (connW[w.i] && w.score > maxWScore) maxWScore = w.score; });
  afterpieces.forEach(function (w) { if (connW[w.i] && w.score > maxWScore) maxWScore = w.score; });

  var ln = [], nm = {};

  mainpieces.forEach(function (w) {
    if (!connW[w.i]) return;
    var sid = 'w' + w.i;
    var sz  = 4 + 18 * Math.sqrt(w.score / maxWScore);
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: w.title, size: sz, color: nodeColor('mainpiece'),
      nodeType: 'work', entityId: w.id, count: w.count, ptype: 'p', x: 0, y: 0
    });
  });

  afterpieces.forEach(function (w) {
    if (!connW[w.i]) return;
    var sid = 'w' + w.i;
    if (g.hasNode(sid)) return;
    var sz  = 4 + 18 * Math.sqrt(w.score / maxWScore);
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: w.title, size: sz, color: nodeColor('afterpiece'),
      nodeType: 'work', entityId: w.id, count: w.count, ptype: 'a', x: 0, y: 0
    });
  });

  var le = [], ec = edgeColor();
  eligible.forEach(function (e) {
    var as = 'w' + e[0], bs = 'w' + e[1];
    if (!g.hasNode(as) || !g.hasNode(bs) || g.hasEdge(as, bs)) return;
    le.push([nm[as], nm[bs]]);
    g.addEdge(as, bs, { size: Math.max(0.5, Math.min(4, Math.log(e[2] + 1))), color: ec });
  });

  layoutBipartite(g, function (node, attrs) { return attrs.ptype === 'p'; });

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

function buildWorkPerformerGraph(data) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allWorks = data.nodes.works;
  var allPerf  = data.nodes.performers;

  var wpMinW = currentDecade === 'all' ? MIN_WP_W * 3 : MIN_WP_W;
  var wpMaxWork = MAX_WORK_WP;
  var wpMaxPerf = MAX_PERF_WP;

  var wScore = new Float64Array(allWorks.length);
  var pScore = new Float64Array(allPerf.length);
  data.edges.workPerformer.forEach(function (e) {
    if (e[2] >= wpMinW) { wScore[e[0]] += e[2]; pScore[e[1]] += e[2]; }
  });

  var topWorks = allWorks
    .map(function (w, i) { return { i: i, id: w.id, title: w.title || w.id, ptype: w.ptype, count: w.count, score: wScore[i] }; })
    .filter(function (w) { return w.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, wpMaxWork);
  var topPerf = allPerf
    .map(function (p, i) { return { i: i, id: p.id, count: p.count, score: pScore[i] }; })
    .filter(function (p) { return p.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, wpMaxPerf);

  var visWork = {}, visPerf = {};
  topWorks.forEach(function (w) { visWork[w.i] = w; });
  topPerf.forEach(function (p) { visPerf[p.i] = p; });

  var eligible = data.edges.workPerformer
    .filter(function (e) { return e[2] >= wpMinW && visWork[e[0]] && visPerf[e[1]]; });

  var connW = {}, connP = {};
  eligible.forEach(function (e) { connW[e[0]] = true; connP[e[1]] = true; });

  var maxWScore = 1, maxPScore = 1;
  topWorks.forEach(function (w) { if (connW[w.i] && w.score > maxWScore) maxWScore = w.score; });
  topPerf.forEach(function (p) { if (connP[p.i] && p.score > maxPScore) maxPScore = p.score; });

  var ln = [], nm = {};

  topWorks.forEach(function (w) {
    if (!connW[w.i]) return;
    var sid = 'w' + w.i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: w.title, size: 4 + 14 * Math.sqrt(w.score / maxWScore),
      color: nodeColor(w.ptype === 'p' ? 'mainpiece' : 'afterpiece'),
      nodeType: 'work', entityId: w.id, count: w.count, ptype: w.ptype, x: 0, y: 0
    });
  });

  topPerf.forEach(function (p) {
    if (!connP[p.i]) return;
    var sid = 'p' + p.i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: p.id, size: 2 + 9 * Math.sqrt(p.score / maxPScore),
      color: nodeColor('performer'),
      nodeType: 'performer', entityId: p.id, count: p.count, x: 0, y: 0
    });
  });

  // Scale edge opacity inversely with edge count so dense all-eras graphs
  // don't blow out at the bipartite convergence band.
  var ec = edgeColor();
  if (isDark() && eligible.length > 60) {
    var baseAlpha = 0.08;
    var alpha = Math.max(0.012, baseAlpha * 60 / eligible.length);
    ec = 'rgba(140,115,75,' + alpha.toFixed(4) + ')';
  }

  var le = [];
  eligible.forEach(function (e) {
    var ws = 'w' + e[0], ps = 'p' + e[1];
    if (!g.hasNode(ws) || !g.hasNode(ps) || g.hasEdge(ws, ps)) return;
    le.push([nm[ws], nm[ps]]);
    g.addEdge(ws, ps, { size: Math.max(0.4, Math.min(3, Math.log(e[2] + 1) * 0.6)), color: ec });
  });

  layoutBipartite(g, function (node, attrs) { return attrs.nodeType === 'work'; });

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

function buildEcosystemGraph(data, abbr) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allPerf    = data.nodes.performers;
  var allTheatre = data.nodes.theatres;
  var allWorks   = data.nodes.works;

  var pScore = new Float64Array(allPerf.length);
  data.edges.theatrePerformer.forEach(function (e) { pScore[e[1]] += e[2]; });
  data.edges.workPerformer.forEach(function (e) { pScore[e[1]] += e[2]; });

  var wScore = new Float64Array(allWorks.length);
  data.edges.workPerformer.forEach(function (e) { wScore[e[0]] += e[2]; });

  var topPerf = allPerf
    .map(function (p, i) { return { i: i, id: p.id, count: p.count, score: pScore[i] }; })
    .filter(function (p) { return p.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_PERF_ECO);
  var topWorks = allWorks
    .map(function (w, i) { return { i: i, id: w.id, title: w.title || w.id, ptype: w.ptype, count: w.count, score: wScore[i] }; })
    .filter(function (w) { return w.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_WORK_ECO);

  var visPerf = {}, visWork = {};
  topPerf.forEach(function (p) { visPerf[p.i] = p; });
  topWorks.forEach(function (w) { visWork[w.i] = w; });

  var connT = {}, connP = {}, connW = {};
  data.edges.theatrePerformer.forEach(function (e) {
    if (visPerf[e[1]]) { connT[e[0]] = true; connP[e[1]] = true; }
  });
  data.edges.workPerformer.forEach(function (e) {
    if (visWork[e[0]] && visPerf[e[1]]) { connW[e[0]] = true; connP[e[1]] = true; }
  });

  var maxTCount = 1, maxPScore2 = 1, maxWScore2 = 1;
  allTheatre.forEach(function (t, i) { if (connT[i] && t.count > maxTCount) maxTCount = t.count; });
  topPerf.forEach(function (p) { if (connP[p.i] && p.score > maxPScore2) maxPScore2 = p.score; });
  topWorks.forEach(function (w) { if (connW[w.i] && w.score > maxWScore2) maxWScore2 = w.score; });

  var ln = [], nm = {};

  allTheatre.forEach(function (t, i) {
    if (!connT[i]) return;
    var sid = 't' + i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: theatreName(t.id, abbr),
      size: 6 + 18 * Math.sqrt(t.count / maxTCount),
      color: nodeColor('theatre'),
      nodeType: 'theatre', entityId: t.id, count: t.count, x: 0, y: 0
    });
  });

  topPerf.forEach(function (p) {
    if (!connP[p.i]) return;
    var sid = 'p' + p.i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: p.id, size: 2 + 9 * Math.sqrt(p.score / maxPScore2),
      color: nodeColor('performer'),
      nodeType: 'performer', entityId: p.id, count: p.count, x: 0, y: 0
    });
  });

  topWorks.forEach(function (w) {
    if (!connW[w.i]) return;
    var sid = 'w' + w.i;
    if (g.hasNode(sid)) return;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: w.title, size: 2 + 9 * Math.sqrt(w.score / maxWScore2),
      color: nodeColor(w.ptype === 'p' ? 'mainpiece' : 'afterpiece'),
      nodeType: 'work', entityId: w.id, count: w.count, ptype: w.ptype, x: 0, y: 0
    });
  });

  var le = [], ec = edgeColor();
  data.edges.theatrePerformer.forEach(function (e) {
    var ts = 't' + e[0], ps = 'p' + e[1];
    if (!g.hasNode(ts) || !g.hasNode(ps) || g.hasEdge(ts, ps)) return;
    le.push([nm[ts], nm[ps]]);
    g.addEdge(ts, ps, { size: Math.max(0.3, Math.min(2.5, Math.log(e[2] + 1) * 0.5)), color: ec });
  });
  data.edges.workPerformer.forEach(function (e) {
    if (!visWork[e[0]] || !visPerf[e[1]]) return;
    var ws = 'w' + e[0], ps = 'p' + e[1];
    if (!g.hasNode(ws) || !g.hasNode(ps) || g.hasEdge(ws, ps)) return;
    le.push([nm[ws], nm[ps]]);
    g.addEdge(ws, ps, { size: Math.max(0.3, Math.min(2.5, Math.log(e[2] + 1) * 0.5)), color: ec });
  });

  layoutTripartite(g, function (node, attrs) {
    if (attrs.nodeType === 'theatre') return 'left';
    if (attrs.nodeType === 'work')    return 'right';
    return 'mid';
  });

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

function buildVenueGraph(data, abbr) {
  var g = new Graph({ multi: false, type: 'undirected' });

  var allTheatre = data.nodes.theatres;

  var perfTheatres = data.nodes.performers.map(function () { return []; });
  data.edges.theatrePerformer.forEach(function (e) { perfTheatres[e[1]].push(e[0]); });

  var sharedMap = {};
  perfTheatres.forEach(function (tList) {
    for (var a = 0; a < tList.length; a++) {
      for (var b = a + 1; b < tList.length; b++) {
        var ti = Math.min(tList[a], tList[b]);
        var tj = Math.max(tList[a], tList[b]);
        var k = ti + '_' + tj;
        sharedMap[k] = (sharedMap[k] || 0) + 1;
      }
    }
  });

  var connT = {};
  Object.keys(sharedMap).forEach(function (k) {
    if (sharedMap[k] < MIN_VEN_W) return;
    var parts = k.split('_');
    connT[+parts[0]] = true; connT[+parts[1]] = true;
  });

  var maxTCount = 1;
  allTheatre.forEach(function (t, i) { if (connT[i] && t.count > maxTCount) maxTCount = t.count; });

  var maxShared = 1;
  Object.keys(sharedMap).forEach(function (k) { if (sharedMap[k] > maxShared) maxShared = sharedMap[k]; });

  var ln = [], nm = {};
  allTheatre.forEach(function (t, i) {
    if (!connT[i]) return;
    var sid = 't' + i;
    nm[sid] = ln.length;
    ln.push({ x: 0, y: 0, dx: 0, dy: 0 });
    g.addNode(sid, {
      label: theatreName(t.id, abbr),
      size: 5 + 22 * Math.sqrt(t.count / maxTCount),
      color: nodeColor('theatre'),
      nodeType: 'theatre', entityId: t.id, count: t.count, x: 0, y: 0
    });
  });

  var le = [], ec = edgeColor();
  Object.keys(sharedMap).forEach(function (k) {
    var w = sharedMap[k];
    if (w < MIN_VEN_W) return;
    var parts = k.split('_');
    var ts = 't' + parts[0], te = 't' + parts[1];
    if (!g.hasNode(ts) || !g.hasNode(te) || g.hasEdge(ts, te)) return;
    le.push([nm[ts], nm[te]]);
    g.addEdge(ts, te, { size: Math.max(0.5, Math.min(6, 1 + 5 * Math.sqrt(w / maxShared))), color: ec });
  });

  layoutFA2(g);

  return { graph: g, nodeCount: g.order, edgeCount: g.size };
}

// ---- UI helpers --------------------------------------------------------------

function setLoading(on) {
  var el = document.getElementById('graph-loading');
  if (el) el.hidden = !on;
}

function updateDecadeLabel(d) {
  var el = document.getElementById('graph-decade-label');
  if (el) el.textContent = d === 'all' ? '1660–1800' : d + 's';
  var sl = document.getElementById('graph-decade-slider');
  if (sl) sl.setAttribute('aria-valuetext', d === 'all' ? '1660–1800' : d + 's');
}

function updateStats(nc, ec) {
  var el = document.getElementById('graph-stats');
  if (el) el.textContent = nc.toLocaleString('en-GB') + ' nodes · ' + ec.toLocaleString('en-GB') + ' edges';
}

function updateLegend(mode) {
  var el = document.getElementById('graph-legend-content');
  if (!el) return;
  var items;
  if (mode === 'theatres') {
    items = [
      { color: C.theatre,   label: 'Playhouse' },
      { color: isDark() ? C.perfDark : C.performer, label: 'Performer' }
    ];
  } else if (mode === 'casting') {
    items = [
      { color: isDark() ? C.perfDark : C.performer, label: 'Performer (size ∝ co-casting weight)' }
    ];
  } else if (mode === 'pairings') {
    items = [
      { color: C.mainpiece,  label: 'Mainpiece' },
      { color: C.afterpiece, label: 'Afterpiece' }
    ];
  } else if (mode === 'works') {
    items = [
      { color: C.mainpiece,  label: 'Mainpiece' },
      { color: C.afterpiece, label: 'Afterpiece' },
      { color: isDark() ? C.perfDark : C.performer, label: 'Performer' }
    ];
  } else if (mode === 'ecosystem') {
    items = [
      { color: C.theatre,    label: 'Playhouse' },
      { color: isDark() ? C.perfDark : C.performer, label: 'Performer' },
      { color: C.mainpiece,  label: 'Mainpiece' },
      { color: C.afterpiece, label: 'Afterpiece' }
    ];
  } else {
    items = [
      { color: C.theatre,    label: 'Playhouse (edge weight = shared performers)' }
    ];
  }
  el.innerHTML = items.map(function (it) {
    return '<div class="legend-row">' +
      '<span class="swatch" style="background:' + it.color + ';border-radius:50%;width:9px;height:9px;display:inline-block;flex-shrink:0"></span>' +
      escHtml(it.label) + '</div>';
  }).join('');
}

function hideInfo() {
  var el = document.getElementById('graph-info');
  if (el) el.hidden = true;
}

function showInfo(nodeId, attrs) {
  var panel   = document.getElementById('graph-info');
  var content = document.getElementById('graph-info-content');
  if (!panel || !content) return;

  var html = '';
  if (attrs.nodeType === 'theatre') {
    html  = '<div class="gi-type metadata-label">Playhouse</div>';
    html += '<div class="gi-name">' + escHtml(attrs.label) + '</div>';
    html += '<div class="gi-count metadata-label">' + Number(attrs.count).toLocaleString('en-GB') + ' event-nights recorded</div>';
    html += '<a class="gi-link" href="venue.html?code=' + encodeURIComponent(attrs.entityId) + '">View venue &rarr;</a>';
  } else if (attrs.nodeType === 'performer') {
    html  = '<div class="gi-type metadata-label">Performer</div>';
    html += '<div class="gi-name">' + escHtml(attrs.label) + '</div>';
    html += '<div class="gi-count metadata-label">' + Number(attrs.count).toLocaleString('en-GB') + ' performances this decade</div>';
    html += '<a class="gi-link" href="performer.html?name=' + encodeURIComponent(attrs.entityId) + '">View profile &rarr;</a>';
  } else if (attrs.nodeType === 'work') {
    var ptl = attrs.ptype === 'p' ? 'Mainpiece' : 'Afterpiece';
    html  = '<div class="gi-type metadata-label">' + ptl + '</div>';
    html += '<div class="gi-name">' + escHtml(attrs.label) + '</div>';
    html += '<div class="gi-count metadata-label">' + Number(attrs.count).toLocaleString('en-GB') + ' performances this decade</div>';
    html += '<a class="gi-link" href="work.html?id=' + encodeURIComponent(attrs.entityId) + '">View work &rarr;</a>';
  }

  content.innerHTML = html;
  panel.hidden = false;
}

// ---- renderer ----------------------------------------------------------------

function destroyRenderer() {
  if (sigmaRenderer) {
    try { sigmaRenderer.kill(); } catch (e) {}
    sigmaRenderer = null;
  }
  var c = document.getElementById('graph-canvas');
  if (c) { while (c.firstChild) c.removeChild(c.firstChild); }
}

function initRenderer(result) {
  var container = document.getElementById('graph-canvas');
  if (!container) return;

  var g  = result.graph;
  var bg = isDark() ? '#1a140d' : '#f1e6cf';
  var lc = isDark() ? '#d9c9a8' : '#2a1f14';

  // sigma 3 removed the backgroundColor setting; apply it to the container instead.
  container.style.backgroundColor = bg;

  sigmaRenderer = new Sigma(g, container, {
    renderEdgeLabels:           false,
    labelFont:                  'Plantin MT Pro, Georgia, serif',
    labelSize:                  11,
    labelWeight:                '400',
    labelColor:                 { attribute: 'labelColor' },
    labelRenderedSizeThreshold: 5,
    defaultEdgeColor:           edgeColor(),
    allowInvalidContainer:      true,
    zoomingRatio:               1.35
  });

  // Seed every node with the default labelColor so the attribute lookup always finds a value.
  g.forEachNode(function (node) { g.setNodeAttribute(node, 'labelColor', lc); });

  // Add proportional padding around small graphs.
  var camPad = Math.max(1.2, 3.0 / Math.log(g.order + 2));
  sigmaRenderer.getCamera().setState({ ratio: camPad });

  var isDragging = false;
  var draggedNode = null;

  sigmaRenderer.on('downNode', function (ev) {
    isDragging = true;
    draggedNode = ev.node;
    if (!sigmaRenderer.getCustomBBox()) sigmaRenderer.setCustomBBox(sigmaRenderer.getBBox());
  });

  sigmaRenderer.on('moveBody', function (ev) {
    if (!isDragging || !draggedNode) return;
    var pos = sigmaRenderer.viewportToGraph(ev.event);
    g.setNodeAttribute(draggedNode, 'x', pos.x);
    g.setNodeAttribute(draggedNode, 'y', pos.y);
    ev.event.preventSigmaDefault();
    ev.event.original.preventDefault();
    ev.event.original.stopPropagation();
  });

  function endDrag() { isDragging = false; draggedNode = null; }
  sigmaRenderer.on('upNode', endDrag);
  sigmaRenderer.on('upStage', endDrag);

  sigmaRenderer.on('clickNode', function (ev) {
    if (!isDragging) {
      var attrs = g.getNodeAttributes(ev.node);
      showInfo(ev.node, attrs);
    }
  });
  sigmaRenderer.on('clickStage', hideInfo);

  var hoveredNode     = null;
  var hoveredNeighbors = null;
  var selectedNode    = null;
  var suggestions     = null;   // Set<nodeKey> | null

  // ---- search ------------------------------------------------------------------
  var searchInput    = document.getElementById('graph-search');
  var searchDatalist = document.getElementById('graph-search-suggestions');

  function populateDatalist() {
    if (!searchDatalist) return;
    searchDatalist.innerHTML = g.nodes().map(function (node) {
      var lbl = g.getNodeAttribute(node, 'label') || '';
      return '<option value="' + lbl.replace(/"/g, '&quot;') + '"></option>';
    }).join('');
  }
  populateDatalist();

  function setSearchQuery(query) {
    if (searchInput && searchInput.value !== query) searchInput.value = query;

    if (query) {
      var lc = query.toLowerCase();
      var matches = g.nodes()
        .map(function (n) { return { n: n, label: (g.getNodeAttribute(n, 'label') || '') }; })
        .filter(function (o) { return o.label.toLowerCase().includes(lc); });

      if (matches.length === 1 && matches[0].label.toLowerCase() === lc) {
        // Perfect single match — select it and pan camera to it.
        selectedNode = matches[0].n;
        suggestions  = null;
        var pos = sigmaRenderer.getNodeDisplayData(selectedNode);
        if (pos) sigmaRenderer.getCamera().animate(pos, { duration: 500 });
      } else {
        selectedNode = null;
        suggestions  = new Set(matches.map(function (o) { return o.n; }));
      }
    } else {
      selectedNode = null;
      suggestions  = null;
    }
    sigmaRenderer.refresh({ skipIndexation: true });
  }

  if (searchInput) {
    searchInput.value = '';
    searchInput.addEventListener('input', function () {
      setSearchQuery(searchInput.value || '');
    });
    searchInput.addEventListener('blur', function () {
      setSearchQuery('');
    });
  }

  // ---- hover -------------------------------------------------------------------
  sigmaRenderer.on('enterNode', function (ev) {
    hoveredNode      = ev.node;
    hoveredNeighbors = new Set(g.neighbors(ev.node));
    if (isDark()) g.setNodeAttribute(ev.node, 'labelColor', '#1a140d');
    sigmaRenderer.refresh({ skipIndexation: true });
    container.style.cursor = 'pointer';
  });
  sigmaRenderer.on('leaveNode', function () {
    if (isDark() && hoveredNode) g.setNodeAttribute(hoveredNode, 'labelColor', lc);
    hoveredNode      = null;
    hoveredNeighbors = null;
    sigmaRenderer.refresh({ skipIndexation: true });
    container.style.cursor = '';
  });

  var fadeColor = isDark() ? '#2a2018' : '#e8dcc8';

  // ---- reducers ----------------------------------------------------------------
  sigmaRenderer.setSetting('nodeReducer', function (node, data) {
    var res = Object.assign({}, data);

    // Hover: dim non-neighbours.
    if (hoveredNeighbors && !hoveredNeighbors.has(node) && hoveredNode !== node) {
      res.label = '';
      res.color = fadeColor;
    }
    // Hover: force-show label on hovered node and its neighbours.
    if (hoveredNode && (node === hoveredNode || (hoveredNeighbors && hoveredNeighbors.has(node)))) {
      res.forceLabel = true;
    }

    // Search: highlight selected node; dim or show suggestions.
    if (selectedNode === node) {
      res.highlighted = true;
      res.forceLabel  = true;
    } else if (suggestions) {
      if (suggestions.has(node)) {
        res.forceLabel = true;
      } else {
        res.label = '';
        res.color = fadeColor;
      }
    }

    return res;
  });

  sigmaRenderer.setSetting('edgeReducer', function (edge, data) {
    var res = Object.assign({}, data);

    if (hoveredNode && !g.extremities(edge).every(function (n) {
      return n === hoveredNode || g.areNeighbors(n, hoveredNode);
    })) {
      res.hidden = true;
    }

    if (suggestions) {
      var ext = g.extremities(edge);
      if (!suggestions.has(ext[0]) || !suggestions.has(ext[1])) res.hidden = true;
    }

    return res;
  });
}

function renderGraph(data, abbr, mode) {
  destroyRenderer();
  hideInfo();
  setLoading(true);

  var result;
  try {
    if (mode === 'theatres')       result = buildTheatreGraph(data, abbr);
    else if (mode === 'casting')   result = buildCastingGraph(data);
    else if (mode === 'pairings')  result = buildPairingsGraph(data);
    else if (mode === 'works')     result = buildWorkPerformerGraph(data);
    else if (mode === 'ecosystem') result = buildEcosystemGraph(data, abbr);
    else                           result = buildVenueGraph(data, abbr);
  } catch (err) {
    console.error('Graph build error:', err);
    setLoading(false);
    return;
  }

  if (result.edgeCount === 0) {
    var el = document.getElementById('graph-loading');
    if (el) {
      var label = currentDecade === 'all' ? 'the full era' : 'the ' + currentDecade + 's';
      el.querySelector('.graph-loading-text').textContent =
        'No records for this view in ' + label + '.';
      el.hidden = false;
    }
    updateStats(0, 0);
    return;
  }

  initRenderer(result);
  updateLegend(mode);
  updateStats(result.nodeCount, result.edgeCount);
  setLoading(false);
}

// ---- load + render -----------------------------------------------------------

function loadAndRender() {
  setLoading(true);
  var d = currentDecade, m = currentMode;
  Promise.all([fetchDecade(d), fetchAbbr()]).then(function (res) {
    renderGraph(res[0], res[1], m);
  }).catch(function (err) {
    console.error('Failed to load graph data:', err);
    setLoading(false);
  });
}

// ---- controls ----------------------------------------------------------------

function initControls() {
  var tabs = document.querySelectorAll('.graph-mode-tab');
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (t) {
        t.classList.remove('is-active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      currentMode = tab.getAttribute('data-mode');
      loadAndRender();
    });
  });

  var slider  = document.getElementById('graph-decade-slider');
  var decadeRow = document.getElementById('graph-decade-row');
  var allBtn  = document.getElementById('graph-all-toggle');

  if (slider) {
    slider.addEventListener('input', function () {
      currentDecade = +slider.value;
      updateDecadeLabel(currentDecade);
    });
    slider.addEventListener('change', function () {
      currentDecade = +slider.value;
      loadAndRender();
    });
  }

  if (allBtn) {
    allBtn.addEventListener('click', function () {
      var active = allBtn.getAttribute('aria-pressed') === 'true';
      if (active) {
        allBtn.setAttribute('aria-pressed', 'false');
        allBtn.classList.remove('is-active');
        currentDecade = slider ? +slider.value : 1760;
        if (decadeRow) decadeRow.hidden = false;
      } else {
        allBtn.setAttribute('aria-pressed', 'true');
        allBtn.classList.add('is-active');
        currentDecade = 'all';
        if (decadeRow) decadeRow.hidden = true;
      }
      updateDecadeLabel(currentDecade);
      loadAndRender();
    });
  }

  var closeBtn = document.getElementById('graph-info-close');
  if (closeBtn) closeBtn.addEventListener('click', hideInfo);
}

// ---- theme change hook -------------------------------------------------------
window.__graphsThemeChange = function () {
  loadAndRender();
};

// ---- boot --------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  updateDecadeLabel(currentDecade);
  initControls();
  loadAndRender();
});
