/* Plotline app: state, persistence, UI wiring, interactions. Maths lives in
   parser.js, drawing in plot.js. */
(function () {
  'use strict';
  var M = window.PlotlineMath, P = window.PlotlinePlot;
  var $ = function (id) { return document.getElementById(id); };
  var esc = ZL.esc;
  var NAMES = ['f', 'g', 'h', 'u', 'v'];
  var MAXF = 5;
  var COLOR_NAMES = ['Blue', 'Red', 'Green', 'Purple', 'Orange', 'Teal'];
  var DEFAULT_VIEW = { cx: 0, cy: 0, xw: 20 };
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function defaultParam() { return { v: 1, min: -10, max: 10, step: 0.1 }; }
  function defaults() {
    return {
      fns: [
        { src: 'a*sin(b*x)', color: 0, visible: true },
        { src: 'x^2/4 - 2', color: 1, visible: true }
      ],
      params: { a: { v: 2, min: -4, max: 4, step: 0.1 }, b: { v: 1, min: 0.1, max: 4, step: 0.1 } },
      view: { cx: 0.6, cy: 0.4, xw: 15 },
      derivative: false, points: true, trace: false, tangent: true, integral: true,
      x0: '5.5', a: '0', b: 'pi', focus: 0,
      table: { start: '-3', step: '0.5', rows: '13' },
      tab: 'fns'
    };
  }

  var state = defaults();
  var PV = {};            // live parameter values, read by every compiled function
  var compiled = [];      // per function: compile result or null
  var errors = [];        // per function: error result or null
  var playing = {};       // name -> direction (+1 / -1) while animating
  var C = {};             // resolved colours

  /* ---------- sanitising and loading ---------- */
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function cleanParams(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (n) {
      var p = obj[n];
      if (!M.isParamLetter(n) || !p) return;
      if (finite(p.v) && finite(p.min) && finite(p.max) && p.max > p.min && finite(p.step) && p.step > 0) out[n] = { v: p.v, min: p.min, max: p.max, step: p.step };
    });
    return out;
  }
  function sanitize(s) {
    var d = defaults();
    if (!s || !Array.isArray(s.fns)) return d;
    var out = {
      fns: s.fns.slice(0, MAXF).map(function (f, i) {
        return { src: String(f && f.src != null ? f.src : ''), color: f && f.color >= 0 && f.color < 6 ? f.color | 0 : i % 6, visible: !(f && f.visible === false) };
      }),
      params: cleanParams(s.params),
      view: s.view && finite(s.view.cx) && finite(s.view.cy) && s.view.xw > 0 ? { cx: s.view.cx, cy: s.view.cy, xw: s.view.xw } : Object.assign({}, DEFAULT_VIEW),
      x0: typeof s.x0 === 'string' ? s.x0 : '1',
      a: typeof s.a === 'string' ? s.a : '0',
      b: typeof s.b === 'string' ? s.b : '1',
      focus: s.focus >= 0 && s.focus < s.fns.length ? s.focus | 0 : 0,
      table: s.table && typeof s.table.start === 'string' ? { start: s.table.start, step: String(s.table.step), rows: String(s.table.rows) } : d.table,
      tab: ['fns', 'calc', 'table'].indexOf(s.tab) >= 0 ? s.tab : 'fns'
    };
    ['derivative', 'points', 'trace', 'tangent', 'integral'].forEach(function (k) { out[k] = !!s[k]; });
    return out;
  }
  function fromHash(h) {
    var d = M.decodeState(h);
    if (!d) return null;
    var s = {
      fns: d.fns.map(function (src, i) { return { src: src, color: d.colors[i] != null ? d.colors[i] : i % 6, visible: d.hidden.indexOf(i) < 0 }; }),
      params: {}, view: d.view, x0: d.x0 != null ? d.x0 : '1', a: d.a != null ? d.a : '0', b: d.b != null ? d.b : '1', focus: d.focus
    };
    d.params.forEach(function (p) { s.params[p.n] = { v: p.v, min: p.min, max: p.max, step: p.step }; });
    ['derivative', 'points', 'trace', 'tangent', 'integral'].forEach(function (k) { s[k] = d[k]; });
    return s;
  }
  function loadInitial() {
    var stored = ZL.store.get('state', null);
    var h = fromHash(location.hash);
    if (h) {
      // links carry the graph; keep the visitor's own table settings and remembered sliders
      var base = stored ? sanitize(stored) : defaults();
      h.table = base.table; h.tab = base.tab;
      h.params = Object.assign({}, base.params, h.params);
      state = sanitize(h);
    } else if (stored) state = sanitize(stored);
    syncPV();
  }
  function syncPV() {
    Object.keys(PV).forEach(function (k) { delete PV[k]; });
    Object.keys(state.params).forEach(function (n) { PV[n] = state.params[n].v; });
  }

  /* ---------- snapshot for links ---------- */
  function usedParams() {
    var set = {};
    compiled.forEach(function (c) { if (c) c.params.forEach(function (n) { set[n] = true; }); });
    return Object.keys(set).sort();
  }
  function hashSnapshot() {
    var hidden = [];
    state.fns.forEach(function (f, i) { if (!f.visible) hidden.push(i); });
    return {
      fns: state.fns.map(function (f) { return f.src; }),
      colors: state.fns.map(function (f) { return f.color; }),
      hidden: hidden,
      params: usedParams().map(function (n) { var p = state.params[n]; return { n: n, v: p.v, min: p.min, max: p.max, step: p.step }; }),
      view: state.view, derivative: state.derivative, points: state.points, trace: state.trace,
      tangent: state.tangent, integral: state.integral, x0: state.x0, a: state.a, b: state.b, focus: state.focus
    };
  }
  function currentHash() { return state.fns.length ? M.encodeState(hashSnapshot()) : ''; }

  var saveTimer = 0, lastHash = null;
  function persist() {
    setStatus('Saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 220);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    var hash = currentHash();
    if (hash !== lastHash) {
      lastHash = hash;
      try { history.replaceState(null, '', hash || location.pathname + location.search); } catch (e) { /* sandboxed */ }
    }
    var ok = ZL.store.set('state', state);
    setStatus(ok ? 'Saved' : 'Not saved: storage is unavailable');
  }

  /* ---------- compile ---------- */
  function ensureParam(n) {
    if (!state.params[n]) state.params[n] = defaultParam();
    PV[n] = state.params[n].v;
  }
  function recompile() {
    compiled = []; errors = [];
    state.fns.forEach(function (f, i) {
      if (!f.src.trim()) { compiled[i] = null; errors[i] = null; return; }
      var c = M.compile(f.src, PV);
      if (c.ok) { compiled[i] = c; errors[i] = null; c.params.forEach(ensureParam); }
      else { compiled[i] = null; errors[i] = c; }
    });
  }
  function isLive(i) { return !!(compiled[i] && state.fns[i] && state.fns[i].visible); }
  function colorOf(i) { return C.pal[state.fns[i].color] || C.pal[0]; }
  function curves() {
    var out = [];
    state.fns.forEach(function (f, i) { if (isLive(i)) out.push({ i: i, fn: compiled[i].fn, color: colorOf(i), focused: i === state.focus }); });
    return out;
  }
  function focusIndex() {
    if (isLive(state.focus)) return state.focus;
    for (var i = 0; i < state.fns.length; i++) if (isLive(i)) return i;
    return -1;
  }
  function label(i) { return NAMES[i] + '(x)'; }

  /* ---------- colours ---------- */
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (k) { return cs.getPropertyValue(k).trim(); };
    C = {
      surface: v('--surface'), raised: v('--raised'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), line: v('--line'),
      gridMinor: P.rgba(v('--line'), ZL.isDark() ? 0.75 : 0.8),
      gridMajor: P.rgba(v('--line-strong'), ZL.isDark() ? 0.95 : 0.9),
      axis: P.rgba(v('--ink-2'), ZL.isDark() ? 0.7 : 0.75),
      pal: [0, 1, 2, 3, 4, 5].map(function (k) { return v('--pl-c' + k); })
    };
  }

  /* ---------- canvas and frame loop ---------- */
  var canvas = $('plot'), ctx = canvas.getContext('2d'), wrap = $('plotWrap');
  var W = 1, H = 1, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, canvas.clientWidth);
    H = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    dirty.points = true;
    syncX0Range();
    requestDraw();
  }
  function view() { return P.View(state.view, W, H); }

  var dirty = { points: true, calc: true, table: true };
  var raf = 0, lastPts = -1e9, lastTable = -1e9, lastFrame = 0, interacting = false;
  function requestDraw() { if (!raf) raf = requestAnimationFrame(frame); }

  function frame(t) {
    raf = 0;
    var dt = lastFrame ? Math.min(0.05, (t - lastFrame) / 1000) : 0.016;
    lastFrame = t;
    var animating = stepParams(dt);
    var moving = stepViewAnim(t);
    var busy = animating || moving || interacting;
    if (dirty.calc) { dirty.calc = false; computeCalc(); }
    if (dirty.points && t - lastPts >= (busy ? 60 : 0)) { dirty.points = false; lastPts = t; computeKeyPoints(); scheduleLists(); }
    if (dirty.table && t - lastTable >= (busy ? 160 : 0)) { dirty.table = false; lastTable = t; renderTable(); }
    if (hl && hl.t < 1) hl.t = Math.min(1, hl.t + dt * 2.2);
    P.render(ctx, W, H, dpr, scene(false));
    if (state.trace) updateTraceBox();
    if (animating || moving || dirty.points || dirty.table || (hl && hl.t < 1)) requestDraw();
    else lastFrame = 0;
  }

  function scene(forExport) {
    var sc = { view: state.view, colors: C, curves: curves(), derivative: state.derivative };
    var fi = focusIndex();
    if (fi >= 0) {
      if (state.integral && intInfo) sc.shade = { fn: compiled[fi].fn, a: intInfo.a, b: intInfo.b, color: colorOf(fi) };
      if (state.tangent && ptInfo) sc.tangent = { x: ptInfo.x, y: ptInfo.y, m: ptInfo.m, color: colorOf(fi) };
    }
    if (state.points) {
      sc.points = keyPts.map(function (p) { return { x: p.x, y: p.y, kind: p.kind, color: colorOf(p.i) }; });
      sc.isects = isects;
    }
    if (!forExport) {
      if (state.trace && traceX != null) sc.trace = { x: traceX };
      if (hl) sc.highlight = hl;
    }
    return sc;
  }

  /* ---------- view changes and animation ---------- */
  function viewChanged() {
    dirty.points = true;
    syncX0Range();
    requestDraw();
    persist();
  }
  var viewAnim = null;
  function animateView(to, dur) {
    if (reduceMotion.matches) { viewAnim = null; state.view = to; viewChanged(); return; }
    viewAnim = { from: Object.assign({}, state.view), to: to, t0: performance.now(), dur: dur || 420 };
    requestDraw();
  }
  function stepViewAnim(t) {
    if (!viewAnim) return false;
    var k = Math.min(1, Math.max(0, (t - viewAnim.t0) / viewAnim.dur));
    var e = 1 - Math.pow(1 - k, 3);
    var a = viewAnim.from, b = viewAnim.to;
    var lw = Math.log(a.xw) + (Math.log(b.xw) - Math.log(a.xw)) * e;
    state.view = { cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e, xw: Math.exp(lw) };
    if (k >= 1) { state.view = Object.assign({}, b); viewAnim = null; }
    dirty.points = true;
    syncX0Range();
    persist();
    return !!viewAnim;
  }
  function zoomAt(factor, px, py) {
    viewAnim = null;
    var v = state.view, V = view();
    var newW = Math.min(1e7, Math.max(1e-6, v.xw * factor));
    factor = newW / v.xw;
    var x = V.fx(px), y = V.fy(py);
    state.view = { cx: x + (v.cx - x) * factor, cy: y + (v.cy - y) * factor, xw: newW };
    viewChanged();
  }
  function zoomAnimated(factor) {
    var v = state.view;
    var newW = Math.min(1e7, Math.max(1e-6, v.xw * factor));
    animateView({ cx: v.cx, cy: v.cy, xw: newW }, 280);
  }
  function panBy(dpx, dpy) {
    viewAnim = null;
    var s = W / state.view.xw;
    state.view = { cx: state.view.cx - dpx / s, cy: state.view.cy + dpy / s, xw: state.view.xw };
    viewChanged();
  }
  function centreOn(x, y) {
    animateView({ cx: x, cy: y, xw: state.view.xw }, 480);
  }

  $('zoomIn').addEventListener('click', function () { zoomAnimated(1 / 1.6); });
  $('zoomOut').addEventListener('click', function () { zoomAnimated(1.6); });
  $('resetView').addEventListener('click', function () { animateView(Object.assign({}, DEFAULT_VIEW), 450); ZL.toast('View reset', { type: 'info' }); });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    var d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.ctrlKey) d *= 2.5; // trackpad pinch arrives as ctrl+wheel
    zoomAt(Math.exp(d * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* pointers: drag to pan, two fingers to pinch, tap a marker to label it */
  var pointers = new Map(), pinch = null, lastPan = null, downAt = null, traceX = null;
  function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function setTraceFromPx(px) { traceX = view().fx(px); requestDraw(); }
  canvas.addEventListener('pointerdown', function (e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    var p = local(e);
    pointers.set(e.pointerId, p);
    viewAnim = null;
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
      lastPan = null; downAt = null;
    } else if (pointers.size === 1) {
      downAt = { x: p.x, y: p.y, t: performance.now() };
      if (state.trace && e.pointerType === 'touch') { lastPan = null; setTraceFromPx(p.x); }
      else { lastPan = p; }
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      interacting = true;
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      var s = W / state.view.xw;
      state.view = { cx: state.view.cx - (mx - pinch.mx) / s, cy: state.view.cy + (my - pinch.my) / s, xw: state.view.xw };
      if (d > 10 && pinch.d > 10) zoomAt(pinch.d / d, mx, my); else viewChanged();
      pinch = { d: d, mx: mx, my: my };
      return;
    }
    if (lastPan && pointers.has(e.pointerId)) {
      if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 4) return;
      downAt = null;
      interacting = true;
      wrap.classList.add('is-dragging');
      panBy(p.x - lastPan.x, p.y - lastPan.y);
      lastPan = p;
      return;
    }
    if (state.trace && (e.pointerType !== 'touch' || pointers.has(e.pointerId))) setTraceFromPx(p.x);
    else if (e.pointerType === 'mouse' && !pointers.size) hover(p);
  });
  function endPointer(e) {
    var p = local(e);
    if (downAt && pointers.size === 1 && performance.now() - downAt.t < 500) tapAt(p);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      lastPan = null; downAt = null; wrap.classList.remove('is-dragging');
      if (interacting) { interacting = false; dirty.points = true; requestDraw(); }
    } else if (pointers.size === 1 && !(state.trace && e.pointerType === 'touch')) lastPan = Array.from(pointers.values())[0];
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', function (e) { downAt = null; endPointer(e); });
  canvas.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && hl && hl.hover) { hl = null; requestDraw(); canvas.style.cursor = ''; } });

  function hitMarker(p) {
    if (!state.points) return null;
    var V = view(), best = null, bd = 14;
    function test(q, labelText, color) {
      var d = Math.hypot(V.px(q.x) - p.x, V.py(q.y) - p.y);
      if (d < bd) { bd = d; best = { x: q.x, y: q.y, label: labelText, color: color }; }
    }
    keyPts.forEach(function (q) { test(q, kindName(q.kind) + ' ' + coord(q.x, q.y), colorOf(q.i)); });
    isects.forEach(function (q) { test(q, 'Intersection ' + coord(q.x, q.y), C.ink); });
    return best;
  }
  function hover(p) {
    var h = hitMarker(p);
    canvas.style.cursor = h ? 'pointer' : '';
    if (h) { if (!hl || hl.x !== h.x || hl.y !== h.y) { h.t = 1; h.hover = true; hl = h; requestDraw(); } }
    else if (hl && hl.hover) { hl = null; requestDraw(); }
  }
  function tapAt(p) {
    var h = hitMarker(p);
    if (h) { h.t = 0; hl = h; requestDraw(); }
    else if (hl) { hl = null; requestDraw(); }
  }

  canvas.addEventListener('keydown', function (e) {
    var step = 48, handled = true;
    if (e.key === 'ArrowLeft') panBy(step, 0);
    else if (e.key === 'ArrowRight') panBy(-step, 0);
    else if (e.key === 'ArrowUp') panBy(0, step);
    else if (e.key === 'ArrowDown') panBy(0, -step);
    else if (e.key === '+' || e.key === '=') zoomAnimated(1 / 1.25);
    else if (e.key === '-' || e.key === '_') zoomAnimated(1.25);
    else if (e.key === '0') animateView(Object.assign({}, DEFAULT_VIEW), 400);
    else handled = false;
    if (handled) e.preventDefault();
  });

  /* overlay toggles on the plot */
  var TOOLS = { optPoints: 'points', optDeriv: 'derivative', optTrace: 'trace' };
  Object.keys(TOOLS).forEach(function (id) {
    $(id).addEventListener('click', function () {
      var k = TOOLS[id];
      state[k] = !state[k];
      if (k === 'trace' && state[k] && traceX == null) traceX = state.view.cx + state.view.xw / 8;
      if (k === 'trace' && !state[k]) $('traceBox').hidden = true;
      if (k === 'points') dirty.points = true;
      syncTools();
      requestDraw(); persist();
    });
  });
  function syncTools() {
    Object.keys(TOOLS).forEach(function (id) { $(id).setAttribute('aria-pressed', String(!!state[TOOLS[id]])); });
    wrap.classList.toggle('is-tracing', state.trace);
  }

  function updateTraceBox() {
    var box = $('traceBox');
    if (!state.trace || traceX == null) { box.hidden = true; return; }
    var html = '<div class="pl-trace-x">x = ' + M.fmt(traceX, 5) + '</div>';
    var any = false;
    state.fns.forEach(function (f, i) {
      if (!isLive(i)) return;
      any = true;
      var fn = compiled[i].fn, y = fn(traceX), m = M.derivative(fn, traceX);
      html += '<div class="pl-trace-row" data-fn="' + i + '" data-y="' + y + '" data-slope="' + m + '"><i style="background:' + colorOf(i) + '"></i>' +
        '<span>' + label(i) + ' = <b>' + M.fmt(y, 5) + '</b></span><small>slope ' + M.fmt(m, 4) + '</small></div>';
    });
    if (!any) html += '<div class="pl-trace-row"><span>No visible functions</span></div>';
    if (box.innerHTML !== html) box.innerHTML = html;
    box.hidden = false;
  }

  /* ---------- key points and intersections ---------- */
  var keyPts = [], isects = [], hl = null;
  function kindName(k) { return k === 'root' ? 'Root' : k === 'max' ? 'Maximum' : 'Minimum'; }
  function coord(x, y) { return '(' + M.fmt(x, 4) + ', ' + M.fmt(y, 4) + ')'; }
  function computeKeyPoints() {
    keyPts = []; isects = [];
    var V = view(), a = V.xMin, b = V.xMax;
    var live = [];
    state.fns.forEach(function (f, i) { if (isLive(i)) live.push(i); });
    var n = interacting || anyPlaying() ? 500 : 1000;
    live.forEach(function (i) {
      var fn = compiled[i].fn;
      M.findRoots(fn, a, b, n).forEach(function (x) { keyPts.push({ i: i, kind: 'root', x: x, y: 0 }); });
      M.findExtrema(fn, a, b, n).forEach(function (e) { keyPts.push({ i: i, kind: e.kind, x: e.x, y: e.y }); });
    });
    for (var p = 0; p < live.length; p++) for (var q = p + 1; q < live.length; q++) {
      var fi = compiled[live[p]].fn, gi = compiled[live[q]].fn;
      M.findIntersections(fi, gi, a, b, n).forEach(function (pt) { isects.push({ i: live[p], j: live[q], x: pt.x, y: pt.y }); });
    }
    isects.sort(function (u, v) { return u.x - v.x; });
  }

  var listTimer = 0;
  function scheduleLists() {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderLists, anyPlaying() || interacting ? 140 : 30);
  }
  var LIST_MAX = 12;
  function ptButton(attrs, dotColors, kind, text) {
    var dots = dotColors.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('');
    return '<li><button type="button" class="pl-pt"' + attrs + '><span class="pl-pt-dots">' + dots + '</span>' +
      '<span class="pl-pt-kind">' + esc(kind) + '</span><span class="pl-pt-val num">' + esc(text) + '</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button></li>';
  }
  function renderLists() {
    var fi = focusIndex();
    var mine = keyPts.filter(function (p) { return p.i === fi; }).sort(function (a, b) { return a.x - b.x; });
    var kl = $('keyList'), xl = $('isectList');
    var html = '';
    mine.slice(0, LIST_MAX).forEach(function (p) {
      html += ptButton(' data-x="' + p.x + '" data-y="' + p.y + '" data-kind="' + p.kind + '"', [colorOf(p.i)], kindName(p.kind),
        p.kind === 'root' ? 'x = ' + M.fmt(p.x, 5) : coord(p.x, p.y));
    });
    if (mine.length > LIST_MAX) html += '<li class="pl-pts-more">and ' + (mine.length - LIST_MAX) + ' more. Zoom in to see them.</li>';
    if (!mine.length) html = '<li class="pl-pts-none">' + (fi < 0 ? 'No function selected.' : 'None in view. Try zooming out.') + '</li>';
    if (kl.innerHTML !== html) kl.innerHTML = html;
    $('keyCount').textContent = String(mine.length);

    html = '';
    isects.slice(0, LIST_MAX).forEach(function (p) {
      html += ptButton(' data-x="' + p.x + '" data-y="' + p.y + '" data-pair="' + NAMES[p.i] + NAMES[p.j] + '"', [colorOf(p.i), colorOf(p.j)],
        NAMES[p.i] + ' and ' + NAMES[p.j], coord(p.x, p.y));
    });
    if (isects.length > LIST_MAX) html += '<li class="pl-pts-more">and ' + (isects.length - LIST_MAX) + ' more. Zoom in to see them.</li>';
    if (!isects.length) html = '<li class="pl-pts-none">' + (curves().length < 2 ? 'Show at least two functions to find where they meet.' : 'The visible functions do not meet in this view.') + '</li>';
    if (xl.innerHTML !== html) xl.innerHTML = html;
    $('isectCount').textContent = String(isects.length);
  }
  function onPointClick(e) {
    var b = e.target.closest('.pl-pt');
    if (!b) return;
    var x = Number(b.dataset.x), y = Number(b.dataset.y);
    var text = b.querySelector('.pl-pt-kind').textContent;
    var isIsect = !!b.dataset.pair;
    var fi = focusIndex();
    hl = { x: x, y: y, t: 0, color: isIsect ? C.ink : colorOf(fi), label: (isIsect ? 'Intersection ' : text + ' ') + coord(x, y) };
    if (!state.points) { state.points = true; syncTools(); dirty.points = true; }
    centreOn(x, y);
    if (innerWidth < 900) wrap.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  $('keyList').addEventListener('click', onPointClick);
  $('isectList').addEventListener('click', onPointClick);

  /* ---------- calculus panel ---------- */
  var ptInfo = null, intInfo = null;
  function setErr(id, msg, inputs) {
    var el = $(id);
    el.textContent = msg || '';
    el.hidden = !msg;
    (inputs || []).forEach(function (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); });
  }
  function prettyBound(s) { return String(s).trim().replace(/pi/gi, 'π').replace(/-/g, '−') || '?'; }
  function computeCalc() {
    var fi = focusIndex();
    $('calcEmpty').hidden = fi >= 0;
    $('calcBody').hidden = fi < 0;
    renderPicker(fi);
    ptInfo = null; intInfo = null;
    if (fi < 0) return;
    var fn = compiled[fi].fn, nm = NAMES[fi];
    // point
    var X = M.evalConstant(state.x0);
    if (!X.ok) {
      setErr('x0Err', 'x: ' + X.error, [$('x0')]);
      $('fx0').textContent = '–'; $('dfx0').textContent = '–'; $('tangentEq').textContent = 'Enter a number for x to see the tangent.';
    } else {
      setErr('x0Err', '', [$('x0')]);
      var y = fn(X.value), m = M.derivative(fn, X.value);
      ptInfo = { x: X.value, y: y, m: m };
      var xs = prettyBound(state.x0);
      $('fx0Label').textContent = nm + '(' + xs + ')';
      $('dfx0Label').textContent = nm + '′(' + xs + '), the slope';
      $('fx0').textContent = M.fmt(y, 5);
      $('dfx0').textContent = isFinite(y) ? M.fmt(m, 5) : '–';
      $('fx0').dataset.value = String(y); $('dfx0').dataset.value = String(m);
      if (!isFinite(y)) $('tangentEq').textContent = nm + ' is undefined at x = ' + xs + '.';
      else if (!isFinite(m) || Math.abs(m) > 1e8) $('tangentEq').textContent = 'No tangent here: the slope is undefined.';
      else {
        var c = y - m * X.value;
        $('tangentEq').textContent = 'Tangent: y = ' + (Math.abs(m) < 1e-12 ? '' : M.fmt(m, 5) + 'x ') + (Math.abs(m) < 1e-12 ? M.fmt(c, 5) : (c < 0 ? '− ' : '+ ') + M.fmt(Math.abs(c), 5));
      }
      if (document.activeElement !== $('x0Range')) $('x0Range').value = String(X.value);
    }
    // integral
    var A = M.evalConstant(state.a), B = M.evalConstant(state.b);
    var msg = '';
    if (!A.ok) msg = 'From: ' + A.error;
    else if (!B.ok) msg = 'To: ' + B.error;
    var res = null;
    if (!msg) { res = M.simpson(fn, A.value, B.value, 4000); if (!res.ok) msg = res.error; }
    setErr('intErr', msg, [!A.ok ? $('intA') : null, A.ok && !B.ok ? $('intB') : null].filter(Boolean));
    if (A.ok) $('intA').removeAttribute('aria-invalid');
    if (B.ok) $('intB').removeAttribute('aria-invalid');
    $('intSym').innerHTML = '<span class="pl-int-i">∫</span><span class="pl-lims"><sup>' + esc(prettyBound(state.b)) + '</sup><sub>' + esc(prettyBound(state.a)) + '</sub></span> ' + nm + '(x) dx =';
    if (msg) { $('intOut').textContent = '–'; $('intOut').dataset.value = ''; return; }
    $('intOut').textContent = M.fmt(res.value, 7);
    $('intOut').dataset.value = String(res.value);
    intInfo = { a: A.value, b: B.value };
  }
  var pickerKey = '';
  function renderPicker(fi) {
    var box = $('calcPick');
    var key = fi + '|' + state.fns.map(function (f, i) { return (isLive(i) ? 1 : 0) + ':' + f.color; }).join(',');
    if (key === pickerKey) return;
    pickerKey = key;
    var html = '';
    state.fns.forEach(function (f, i) {
      if (!isLive(i)) return;
      html += '<button type="button" data-i="' + i + '" aria-pressed="' + (i === fi) + '"><i class="pl-dot" style="background:' + colorOf(i) + '"></i>' + label(i) + '</button>';
    });
    box.innerHTML = html;
    box.hidden = !html;
  }
  $('calcPick').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]');
    if (!b) return;
    selectFn(Number(b.dataset.i));
  });
  function selectFn(i) {
    if (state.focus === i) return;
    state.focus = i;
    fnList.querySelectorAll('.pl-fn').forEach(function (r, k) { r.classList.toggle('is-selected', k === i); });
    dirty.calc = true; scheduleLists(); requestDraw(); persist();
  }

  $('x0').addEventListener('input', function () { state.x0 = this.value; dirty.calc = true; requestDraw(); persist(); });
  $('x0Range').addEventListener('input', function () {
    var v = Number(this.value), st = P.niceStep(state.view.xw / 400);
    var r = M.cleanNum(Math.round(v / st) * st);
    state.x0 = String(Number(r.toPrecision(10)));
    $('x0').value = state.x0;
    dirty.calc = true; requestDraw(); persist();
  });
  function syncX0Range() {
    var r = $('x0Range'), V = view();
    r.min = String(V.xMin); r.max = String(V.xMax); r.step = String(state.view.xw / 400);
    if (ptInfo) r.value = String(ptInfo.x);
  }
  ['intA', 'intB'].forEach(function (id) {
    $(id).addEventListener('input', function () { state[id === 'intA' ? 'a' : 'b'] = this.value; dirty.calc = true; requestDraw(); persist(); });
  });
  $('optTangent').addEventListener('change', function () { state.tangent = this.checked; requestDraw(); persist(); });
  $('optIntegral').addEventListener('change', function () { state.integral = this.checked; requestDraw(); persist(); });

  /* ---------- function rows ---------- */
  var fnList = $('fnList');
  var lastInput = null, newRow = -1;
  var ICON = {
    handle: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6.5" r="1.6"/><circle cx="15" cy="6.5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="17.5" r="1.6"/><circle cx="15" cy="17.5" r="1.6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12.5h10L18 7M9.5 7V4.5h5V7"/></svg>'
  };

  function renderRows() {
    var focusedId = document.activeElement && document.activeElement.id;
    fnList.textContent = '';
    state.fns.forEach(function (f, i) {
      var li = document.createElement('li');
      li.className = 'pl-fn' + (i === newRow ? ' is-new' : '') + (i === state.focus ? ' is-selected' : '') + (f.visible ? '' : ' is-hidden');
      li.style.setProperty('--c', 'var(--pl-c' + f.color + ')');
      var id = 'fn' + i, nm = label(i);
      li.innerHTML =
        '<button type="button" class="pl-handle" aria-label="Reorder ' + nm + '. Drag, or press the up and down arrow keys." data-tip="Drag to reorder">' + ICON.handle + '</button>' +
        '<button type="button" class="pl-swatch" aria-label="Colour of ' + nm + ': ' + COLOR_NAMES[f.color] + '. Change colour" aria-haspopup="dialog"><span>' + NAMES[i] + '</span></button>' +
        '<div class="pl-expr-wrap">' +
          '<label class="sr-only" for="' + id + '">' + nm + ' =</label>' +
          '<div class="pl-mirror" aria-hidden="true"></div>' +
          '<input class="pl-expr" id="' + id + '" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next" placeholder="Type a function of x" aria-describedby="' + id + 'err">' +
        '</div>' +
        '<button type="button" class="pl-icon pl-vis" aria-pressed="' + (!f.visible) + '" aria-label="' + (f.visible ? 'Hide ' : 'Show ') + nm + '" data-tip="' + (f.visible ? 'Hide' : 'Show') + '">' + (f.visible ? ICON.eye : ICON.eyeOff) + '</button>' +
        '<button type="button" class="pl-icon pl-del" aria-label="Delete ' + nm + '" data-tip="Delete">' + ICON.del + '</button>' +
        '<p class="zl-error pl-fn-err" id="' + id + 'err" role="alert" hidden></p>';
      var input = li.querySelector('input');
      input.value = f.src;
      wireRow(li, input, i);
      fnList.appendChild(li);
      showRowError(i, li);
    });
    $('fnEmpty').hidden = state.fns.length > 0;
    var full = state.fns.length >= MAXF;
    $('addFn').disabled = full;
    $('addFn').querySelector('span').textContent = full ? 'Five functions is the limit' : 'Add function';
    $('fnCount').textContent = state.fns.length + ' of ' + MAXF;
    if (focusedId && $(focusedId)) $(focusedId).focus({ preventScroll: true });
    newRow = -1;
  }

  function wireRow(li, input, i) {
    var mirror = li.querySelector('.pl-mirror');
    var syncScroll = function () { mirror.scrollLeft = input.scrollLeft; };
    input.addEventListener('input', function () {
      state.fns[i].src = input.value;
      functionsChanged();
      showRowError(i, li);
      syncScroll();
    });
    ['scroll', 'keyup', 'select', 'click'].forEach(function (ev) { input.addEventListener(ev, syncScroll); });
    input.addEventListener('focus', function () { lastInput = input; selectFn(i); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var next = $('fn' + (i + 1));
        if (next) next.focus();
        else if (state.fns.length < MAXF) addFunction('');
      } else if (e.key === 'ArrowDown' && $('fn' + (i + 1))) { e.preventDefault(); $('fn' + (i + 1)).focus(); }
      else if (e.key === 'ArrowUp' && $('fn' + (i - 1))) { e.preventDefault(); $('fn' + (i - 1)).focus(); }
    });
    li.addEventListener('pointerdown', function (e) { if (!e.target.closest('button')) selectFn(i); });
    li.querySelector('.pl-vis').addEventListener('click', function () {
      var f = state.fns[i];
      f.visible = !f.visible;
      renderRows(); functionsChanged();
      fnList.querySelectorAll('.pl-vis')[i].focus();
      ZL.toast(label(i) + (f.visible ? ' shown' : ' hidden'), { type: 'info' });
    });
    li.querySelector('.pl-del').addEventListener('click', function () { deleteFunction(i); });
    li.querySelector('.pl-swatch').addEventListener('click', function (e) { e.stopPropagation(); openColors(i, this); });
    wireDrag(li, li.querySelector('.pl-handle'), i);
  }

  function showRowError(i, li) {
    li = li || fnList.children[i];
    if (!li) return;
    var e = errors[i], err = li.querySelector('.pl-fn-err'), input = li.querySelector('input'), mirror = li.querySelector('.pl-mirror');
    var src = state.fns[i].src;
    if (!e) {
      err.hidden = true; err.textContent = ''; li.removeAttribute('data-invalid'); input.removeAttribute('aria-invalid');
      mirror.textContent = '';
      return;
    }
    err.textContent = e.error; err.hidden = false;
    li.setAttribute('data-invalid', 'true'); input.setAttribute('aria-invalid', 'true');
    var a = Math.max(0, Math.min(e.pos, src.length)), b = Math.max(a, Math.min(e.end, src.length));
    var bad = src.slice(a, b);
    mirror.innerHTML = esc(src.slice(0, a)) + '<mark>' + (bad ? esc(bad) : '&nbsp;') + '</mark>' + esc(src.slice(b));
    mirror.scrollLeft = input.scrollLeft;
  }

  function functionsChanged() {
    recompile();
    renderSliders();
    dirty.points = true; dirty.calc = true; dirty.table = true;
    pickerKey = '';
    var labels = state.fns.map(function (f, i) { return label(i) + ' = ' + (f.src || 'empty'); }).join('; ');
    canvas.setAttribute('aria-label', state.fns.length ? 'Graph of ' + labels : 'Empty graph');
    updateStatus();
    requestDraw();
    persist();
  }

  function addFunction(src) {
    if (state.fns.length >= MAXF) { ZL.toast('Five functions is the limit', { type: 'bad' }); return; }
    var used = state.fns.map(function (f) { return f.color; });
    var color = 0;
    for (var k = 0; k < 6; k++) if (used.indexOf(k) < 0) { color = k; break; }
    state.fns.push({ src: src || '', color: color, visible: true });
    state.focus = state.fns.length - 1;
    newRow = state.focus;
    recompile(); renderRows(); functionsChanged();
    var inp = $('fn' + state.focus);
    if (inp) { inp.focus(); lastInput = inp; }
    return inp;
  }
  $('addFn').addEventListener('click', function () {
    addFunction('');
    ZL.toast(label(state.fns.length - 1) + ' added. Start typing.', { type: 'info' });
  });

  function deleteFunction(i) {
    var removed = state.fns[i], wasFocus = state.focus;
    state.fns.splice(i, 1);
    if (state.focus >= state.fns.length) state.focus = Math.max(0, state.fns.length - 1);
    else if (state.focus > i) state.focus--;
    recompile(); renderRows(); functionsChanged();
    var inputs = fnList.querySelectorAll('input');
    if (inputs.length) inputs[Math.min(i, inputs.length - 1)].focus({ preventScroll: true });
    else $('addFn').focus();
    ZL.toast('Deleted ' + (removed.src ? removed.src : 'empty function'), {
      action: { label: 'Undo', fn: function () {
        if (state.fns.length >= MAXF) return;
        state.fns.splice(i, 0, removed);
        state.focus = wasFocus; newRow = i;
        recompile(); renderRows(); functionsChanged();
        ZL.toast('Restored');
      } }
    });
  }

  function moveFn(from, to) {
    if (to < 0 || to >= state.fns.length || from === to) return false;
    var f = state.fns.splice(from, 1)[0];
    state.fns.splice(to, 0, f);
    if (state.focus === from) state.focus = to;
    else if (from < state.focus && to >= state.focus) state.focus--;
    else if (from > state.focus && to <= state.focus) state.focus++;
    recompile(); requestDraw();
    return true;
  }

  /* drag to reorder: pointer based, so it works with touch too */
  function wireDrag(li, handle, i) {
    var drag = null;
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      drag = { y: e.clientY, from: i, idx: i, moved: false };
      li.classList.add('is-dragging');
      fnList.classList.add('is-sorting');
    });
    handle.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y;
      if (Math.abs(dy) > 3) drag.moved = true;
      li.style.transform = 'translateY(' + dy + 'px)';
      var rows = Array.prototype.slice.call(fnList.children);
      var idx = rows.indexOf(li), r = li.getBoundingClientRect(), mid = r.top + r.height / 2;
      var next = rows[idx + 1], prev = rows[idx - 1], before;
      if (next) {
        var nr = next.getBoundingClientRect();
        if (mid > nr.top + nr.height / 2) {
          before = li.offsetTop;
          fnList.insertBefore(next, li);
          moveFn(idx, idx + 1); drag.idx = idx + 1;
          drag.y += li.offsetTop - before;
          li.style.transform = 'translateY(' + (e.clientY - drag.y) + 'px)';
          return;
        }
      }
      if (prev) {
        var pr = prev.getBoundingClientRect();
        if (mid < pr.top + pr.height / 2) {
          before = li.offsetTop;
          fnList.insertBefore(prev, li.nextSibling); // move the neighbour so the dragged row keeps pointer capture
          moveFn(idx, idx - 1); drag.idx = idx - 1;
          drag.y += li.offsetTop - before;
          li.style.transform = 'translateY(' + (e.clientY - drag.y) + 'px)';
        }
      }
    });
    function end() {
      if (!drag) return;
      var d = drag; drag = null;
      li.classList.remove('is-dragging'); fnList.classList.remove('is-sorting');
      li.style.transform = '';
      if (d.idx !== d.from) {
        recompile(); renderRows(); functionsChanged();
        var h = fnList.querySelectorAll('.pl-handle')[d.idx];
        if (h) h.focus({ preventScroll: true });
        ZL.toast('Moved to position ' + (d.idx + 1) + ', now ' + label(d.idx));
      }
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('keydown', function (e) {
      var to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
      if (to == null) return;
      e.preventDefault();
      if (!moveFn(i, to)) return;
      recompile(); renderRows(); functionsChanged();
      fnList.querySelectorAll('.pl-handle')[to].focus();
      ZL.toast('Moved to position ' + (to + 1), { type: 'info' });
    });
  }

  /* colour picker */
  var pop = $('colorPop'), popFor = -1, popBtn = null;
  function openColors(i, btn) {
    if (popFor === i && !pop.hidden) { closeColors(); return; }
    popFor = i; popBtn = btn;
    pop.innerHTML = '<p>Colour for ' + label(i) + '</p><div class="pl-colorpop-grid">' + COLOR_NAMES.map(function (n, k) {
      return '<button type="button" data-k="' + k + '" aria-pressed="' + (state.fns[i].color === k) + '" aria-label="' + n + '" style="--c:var(--pl-c' + k + ')"></button>';
    }).join('') + '</div>';
    pop.hidden = false;
    var r = btn.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left + window.scrollX - 8), document.documentElement.clientWidth - pop.offsetWidth - 8 + window.scrollX);
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + window.scrollY + 8) + 'px';
    pop.querySelector('[aria-pressed="true"]').focus();
  }
  function closeColors(refocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    if (refocus && popBtn) popBtn.focus();
    popFor = -1;
  }
  pop.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-k]');
    if (!b || popFor < 0) return;
    var i = popFor;
    state.fns[i].color = Number(b.dataset.k);
    closeColors();
    renderRows(); functionsChanged();
    var sw = fnList.querySelectorAll('.pl-swatch')[i];
    if (sw) sw.focus();
  });
  pop.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeColors(true); }
    var bs = Array.prototype.slice.call(pop.querySelectorAll('button')), k = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowRight' && k >= 0) { e.preventDefault(); bs[(k + 1) % bs.length].focus(); }
    if (e.key === 'ArrowLeft' && k >= 0) { e.preventDefault(); bs[(k - 1 + bs.length) % bs.length].focus(); }
  });
  document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) closeColors(); });

  /* insert keys for touch users */
  $('keys').addEventListener('pointerdown', function (e) { if (e.pointerType === 'mouse' && e.target.closest('button')) e.preventDefault(); });
  $('keys').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-ins]');
    if (!b) return;
    var input = lastInput && document.body.contains(lastInput) ? lastInput : $('fn' + state.focus);
    if (!input) input = addFunction('');
    if (!input) return;
    var tpl = b.dataset.ins, s = input.selectionStart, en = input.selectionEnd;
    if (s == null) { s = en = input.value.length; }
    var sel = input.value.slice(s, en), cut = tpl.indexOf('|');
    var ins = cut >= 0 ? tpl.slice(0, cut) + sel + tpl.slice(cut + 1) : tpl;
    input.value = input.value.slice(0, s) + ins + input.value.slice(en);
    var caret = cut >= 0 ? s + cut + sel.length : s + ins.length;
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  /* ---------- sliders ---------- */
  var sliderKey = null;
  var PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
  function decimals(step) { return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9))); }
  function fmtParam(n, v) { var d = decimals(state.params[n].step); return Number(v.toFixed(d)).toFixed(d); }
  function anyPlaying() { for (var k in playing) return true; return false; }

  function renderSliders() {
    var used = usedParams();
    var key = used.join(',');
    Object.keys(playing).forEach(function (n) { if (used.indexOf(n) < 0) delete playing[n]; });
    $('paramEmpty').hidden = used.length > 0;
    $('paramCount').hidden = !used.length;
    $('paramCount').textContent = used.length + (used.length === 1 ? ' slider' : ' sliders');
    if (key === sliderKey) return;
    sliderKey = key;
    var box = $('sliders');
    box.textContent = '';
    used.forEach(function (n) {
      var p = state.params[n];
      var row = document.createElement('div');
      row.className = 'pl-slider';
      row.dataset.p = n;
      row.innerHTML =
        '<div class="pl-slider-top">' +
          '<button type="button" class="pl-play" aria-pressed="false" aria-label="Play ' + n + '" data-tip="Animate ' + n + '">' + PLAY + '</button>' +
          '<label class="pl-pname" for="pv-' + n + '"><i>' + n + '</i> =</label>' +
          '<input class="zl-input pl-pval num" id="pv-' + n + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-describedby="pe-' + n + '">' +
          '<input type="range" class="pl-range" id="pr-' + n + '" aria-label="' + n + ' slider">' +
        '</div>' +
        '<div class="pl-slider-lims">' +
          '<label class="pl-lim"><span>Min</span><input class="zl-input num" data-k="min" type="text" inputmode="decimal" aria-label="Minimum for ' + n + '"></label>' +
          '<label class="pl-lim"><span>Step</span><input class="zl-input num" data-k="step" type="text" inputmode="decimal" aria-label="Step for ' + n + '"></label>' +
          '<label class="pl-lim"><span>Max</span><input class="zl-input num" data-k="max" type="text" inputmode="decimal" aria-label="Maximum for ' + n + '"></label>' +
        '</div>' +
        '<span class="zl-error" id="pe-' + n + '" hidden></span>';
      box.appendChild(row);
      wireSlider(row, n);
      syncSlider(n, true);
    });
  }

  function syncSlider(n, all) {
    var row = $('sliders').querySelector('[data-p="' + n + '"]');
    if (!row) return;
    var p = state.params[n], r = row.querySelector('.pl-range'), val = row.querySelector('.pl-pval');
    if (all) {
      r.min = String(p.min); r.max = String(p.max); r.step = String(p.step);
      row.querySelectorAll('[data-k]').forEach(function (inp) { if (document.activeElement !== inp) inp.value = String(Number(p[inp.dataset.k].toPrecision(10))); });
    }
    if (document.activeElement !== r) r.value = String(p.v);
    if (document.activeElement !== val || playing[n]) val.value = fmtParam(n, p.v);
    var pct = (p.v - p.min) / (p.max - p.min) * 100;
    r.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
    var pb = row.querySelector('.pl-play'), on = !!playing[n];
    if (pb.getAttribute('aria-pressed') !== String(on)) {
      pb.setAttribute('aria-pressed', String(on));
      pb.setAttribute('aria-label', (on ? 'Pause ' : 'Play ') + n);
      pb.setAttribute('data-tip', (on ? 'Pause ' : 'Animate ') + n);
      pb.innerHTML = on ? PAUSE : PLAY;
      row.classList.toggle('is-playing', on);
    }
  }

  function setParam(n, v, quiet) {
    state.params[n].v = v;
    PV[n] = v;
    dirty.points = true; dirty.calc = true; dirty.table = true;
    if (!quiet) { syncSlider(n); persist(); }
    requestDraw();
  }

  function wireSlider(row, n) {
    var r = row.querySelector('.pl-range'), val = row.querySelector('.pl-pval'), err = row.querySelector('.zl-error');
    function showErr(msg, inp) {
      err.textContent = msg || ''; err.hidden = !msg;
      row.querySelectorAll('input').forEach(function (x) { x.removeAttribute('aria-invalid'); });
      if (msg && inp) inp.setAttribute('aria-invalid', 'true');
    }
    r.addEventListener('input', function () { stopPlay(n); showErr(''); setParam(n, Number(r.value)); });
    val.addEventListener('input', function () {
      var c = M.evalConstant(val.value);
      if (!c.ok) { showErr('Value: ' + c.error, val); return; }
      showErr('');
      var p = state.params[n];
      stopPlay(n);
      if (c.value < p.min || c.value > p.max) {
        if (c.value < p.min) p.min = c.value; else p.max = c.value;
        syncSlider(n, true);
      }
      setParam(n, c.value, true);
      syncSlider(n);
      persist();
    });
    val.addEventListener('blur', function () { syncSlider(n, true); });
    row.querySelectorAll('[data-k]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var k = inp.dataset.k, c = M.evalConstant(inp.value), p = state.params[n];
        if (!c.ok) { showErr((k === 'step' ? 'Step' : k === 'min' ? 'Min' : 'Max') + ': ' + c.error, inp); return; }
        var next = Object.assign({}, p); next[k] = c.value;
        if (k === 'step' && !(c.value > 0)) { showErr('Step must be more than 0.', inp); return; }
        if (next.min >= next.max) { showErr('Min must be less than max.', inp); return; }
        showErr('');
        p[k] = c.value;
        if (p.v < p.min || p.v > p.max) setParam(n, Math.min(p.max, Math.max(p.min, p.v)), true);
        syncSlider(n, true); persist();
        ZL.toast('Slider ' + n + ' now runs from ' + M.fmt(p.min) + ' to ' + M.fmt(p.max) + ' in steps of ' + M.fmt(p.step), { type: 'info' });
      });
    });
    row.querySelector('.pl-play').addEventListener('click', function () {
      if (playing[n]) stopPlay(n); else { playing[n] = state.params[n].v >= state.params[n].max ? -1 : 1; lastFrame = 0; requestDraw(); }
      syncSlider(n); updateStatus();
    });
  }

  function stopPlay(n) {
    if (!playing[n]) return;
    delete playing[n];
    var p = state.params[n];
    var snapped = M.cleanNum(Math.round((p.v - p.min) / p.step) * p.step + p.min);
    setParam(n, Number(Math.min(p.max, Math.max(p.min, snapped)).toPrecision(12)));
    syncSlider(n); updateStatus(); persist();
  }

  /* one full sweep from min to max takes about 3.2 seconds */
  function stepParams(dt) {
    var any = false;
    Object.keys(playing).forEach(function (n) {
      var p = state.params[n];
      if (!p) { delete playing[n]; return; }
      any = true;
      var v = p.v + playing[n] * (p.max - p.min) * dt / 3.2;
      if (v >= p.max) { v = p.max; playing[n] = -1; }
      if (v <= p.min) { v = p.min; playing[n] = 1; }
      setParam(n, v, true);
      syncSlider(n);
    });
    return any;
  }

  /* ---------- table of values ---------- */
  var tableRows = [];
  function tableSpec() {
    var t = state.table;
    var S = M.evalConstant(t.start), D = M.evalConstant(t.step), N = Number(t.rows);
    if (!S.ok) return { error: 'Start x: ' + S.error, field: 'tStart' };
    if (!D.ok) return { error: 'Step: ' + D.error, field: 'tStep' };
    if (D.value === 0) return { error: 'Step can’t be 0. Try 1 or 0.5.', field: 'tStep' };
    if (!(Number.isInteger(N) && N >= 1 && N <= 200)) return { error: 'Rows must be a whole number from 1 to 200.', field: 'tRows' };
    return { start: S.value, step: D.value, rows: N };
  }
  function renderTable() {
    var spec = tableSpec();
    ['tStart', 'tStep', 'tRows'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
    setErr('tErr', spec.error || '');
    if (spec.error) $(spec.field).setAttribute('aria-invalid', 'true');
    var cols = [];
    state.fns.forEach(function (f, i) { if (isLive(i)) cols.push(i); });
    var empty = !cols.length || !!spec.error;
    $('tableEmpty').hidden = !!spec.error || cols.length > 0;
    $('tableWrap').hidden = empty;
    $('copyCsv').disabled = empty;
    tableRows = [];
    if (empty) { $('valTable').innerHTML = ''; return; }
    for (var k = 0; k < spec.rows; k++) {
      var x = Number((spec.start + k * spec.step).toPrecision(12));
      tableRows.push([x].concat(cols.map(function (i) { return compiled[i].fn(x); })));
    }
    var html = '<thead><tr><th scope="col">x</th>' + cols.map(function (i) {
      return '<th scope="col"><i class="pl-dot" style="background:' + colorOf(i) + '"></i>' + label(i) + '</th>';
    }).join('') + '</tr></thead><tbody>';
    tableRows.forEach(function (r) {
      html += '<tr><th scope="row">' + M.fmt(r[0], 6) + '</th>' + r.slice(1).map(function (v) {
        return '<td' + (isFinite(v) ? '' : ' class="is-undef"') + '>' + M.fmt(v, 6) + '</td>';
      }).join('') + '</tr>';
    });
    $('valTable').innerHTML = html + '</tbody>';
    $('valTable').dataset.cols = cols.map(function (i) { return NAMES[i]; }).join('');
  }
  function csvNum(v) { return isFinite(v) ? String(Number(v.toPrecision(10))) : ''; }
  function tableCSV() {
    var cols = [];
    state.fns.forEach(function (f, i) { if (isLive(i)) cols.push(label(i)); });
    return ['x'].concat(cols).join(',') + '\n' + tableRows.map(function (r) { return r.map(csvNum).join(','); }).join('\n');
  }
  [['tStart', 'start'], ['tStep', 'step'], ['tRows', 'rows']].forEach(function (pair) {
    $(pair[0]).addEventListener('input', function () { state.table[pair[1]] = this.value; renderTable(); persist(); });
  });
  $('copyCsv').addEventListener('click', function () {
    if (!tableRows.length) return;
    var csv = tableCSV();
    $('copyCsv').dataset.csv = csv;
    Promise.resolve(ZL.copy(csv)).then(function (ok) {
      ZL.toast(ok ? 'Copied ' + tableRows.length + ' rows as CSV' : 'Copy failed. Select the table and copy it instead.', { type: ok ? 'good' : 'bad' });
    });
  });

  /* ---------- examples ---------- */
  var EXAMPLES = [
    { name: 'Parameter family a·sin(bx)', desc: 'Two sliders. Press play on b to watch the frequency change.', fns: ['a*sin(b*x)'],
      params: { a: { v: 2, min: -4, max: 4, step: 0.1 }, b: { v: 1, min: 0.2, max: 4, step: 0.1 } }, view: { cx: 0, cy: 0, xw: 16 }, play: 'b', x0: '1', a: '0', b: 'pi' },
    { name: 'Damped wave', desc: 'A sine wave inside its decaying envelope.', fns: ['e^(-0.25x)*sin(3x)', 'e^(-0.25x)', '-e^(-0.25x)'], colors: [0, 5, 5],
      view: { cx: 5.5, cy: 0, xw: 14 }, x0: '1', a: '0', b: '2', flags: { points: false } },
    { name: 'Cubic', desc: 'Three roots, a maximum and a minimum.', fns: ['x^3 - 3x'], view: { cx: 0, cy: 0, xw: 9 }, x0: '1.5', a: '-1', b: '1' },
    { name: 'Bell curve', desc: 'The normal distribution. About 68% of the area lies within one unit.', fns: ['e^(-x^2/2)/sqrt(2pi)'],
      view: { cx: 0, cy: 0.2, xw: 8 }, x0: '1', a: '-1', b: '1', flags: { tangent: false } },
    { name: 'Asymptotes', desc: 'A vertical asymptote at x = 1 and a horizontal one at y = 2.', fns: ['(2x+1)/(x-1)', '2'], colors: [3, 4],
      view: { cx: 1, cy: 2, xw: 16 }, x0: '3', a: '2', b: '4', flags: { tangent: false } },
    { name: 'Line meets parabola', desc: 'x² and x + 2 cross at (−1, 1) and (2, 4).', fns: ['x^2', 'x+2'], view: { cx: 0.5, cy: 2, xw: 10 }, x0: '0.5', a: '-1', b: '2', flags: { tangent: false } },
    { name: 'Tangent to ln(x)', desc: 'At x = e the tangent passes through the origin.', fns: ['ln(x)'], view: { cx: 2.5, cy: 0.5, xw: 9 }, x0: 'e', a: '1', b: 'e', flags: { integral: false } },
    { name: 'Growth and decay', desc: 'Slide k through zero to switch from decay to growth.', fns: ['a*e^(k*x)'],
      params: { a: { v: 1, min: 0.1, max: 3, step: 0.1 }, k: { v: 0.5, min: -1.5, max: 1.5, step: 0.05 } }, view: { cx: 0, cy: 2, xw: 10 }, play: 'k', x0: '0', a: '0', b: '1', flags: { integral: false } }
  ];

  function renderGallery() {
    var grid = $('galleryGrid');
    grid.innerHTML = EXAMPLES.map(function (ex, k) {
      return '<button type="button" class="pl-ex" data-k="' + k + '"><svg class="pl-mini" viewBox="0 0 240 120" aria-hidden="true"></svg>' +
        '<span class="pl-ex-name">' + esc(ex.name) + '</span><span class="pl-ex-desc">' + esc(ex.desc) + '</span>' +
        '<code class="pl-ex-src">' + esc(ex.fns[0]) + (ex.fns.length > 1 ? ' + ' + (ex.fns.length - 1) + ' more' : '') + '</code></button>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.pl-ex'), function (b, k) {
      var ex = EXAMPLES[k], v = ex.view, half = v.xw / 2, hh = v.xw / 4;
      var pv = {};
      Object.keys(ex.params || {}).forEach(function (n) { pv[n] = ex.params[n].v; });
      P.miniSvg(b.querySelector('svg'), {
        view: [v.cx - half, v.cx + half, v.cy - hh, v.cy + hh], params: pv,
        curves: ex.fns.map(function (f, i) { return { f: f, c: ex.colors ? ex.colors[i] : i }; })
      });
    });
  }
  function loadExample(k) {
    var ex = EXAMPLES[k], prev = JSON.parse(JSON.stringify(state));
    Object.keys(playing).forEach(function (n) { delete playing[n]; });
    state.fns = ex.fns.map(function (src, i) { return { src: src, color: ex.colors ? ex.colors[i] : i, visible: true }; });
    Object.keys(ex.params || {}).forEach(function (n) { state.params[n] = Object.assign({}, ex.params[n]); });
    syncPV();
    var fl = Object.assign({ derivative: false, points: true, trace: false, tangent: true, integral: true }, ex.flags || {});
    Object.keys(fl).forEach(function (f) { state[f] = fl[f]; });
    state.x0 = ex.x0; state.a = ex.a; state.b = ex.b; state.focus = 0;
    hl = null; traceX = null;
    animateView(Object.assign({}, ex.view), 500);
    afterBulkChange();
    if (ex.play) { playing[ex.play] = 1; syncSlider(ex.play); updateStatus(); requestDraw(); }
    ZL.toast('Loaded ' + ex.name, { action: { label: 'Undo', fn: function () {
      Object.keys(playing).forEach(function (n) { delete playing[n]; });
      state = prev; syncPV(); afterBulkChange(); ZL.toast('Back to your graph');
    } } });
  }
  function afterBulkChange() {
    recompile(); sliderKey = null; pickerKey = '';
    syncControls(); renderRows(); functionsChanged(); syncTools();
    if (state.trace && traceX == null) traceX = state.view.cx + state.view.xw / 8;
  }
  var gallery = $('gallery');
  $('examplesBtn').addEventListener('click', function () { renderGallery(); gallery.showModal(); var f = gallery.querySelector('.pl-ex'); if (f) f.focus(); });
  $('galleryClose').addEventListener('click', function () { gallery.close(); });
  gallery.addEventListener('click', function (e) {
    if (e.target === gallery) { gallery.close(); return; }
    var b = e.target.closest('.pl-ex');
    if (!b) return;
    gallery.close();
    loadExample(Number(b.dataset.k));
    $('app').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  });

  /* ---------- export and share ---------- */
  function legend() {
    var rows = [];
    state.fns.forEach(function (f, i) { if (isLive(i)) rows.push({ color: colorOf(i), text: label(i) + ' = ' + f.src.trim() }); });
    var used = usedParams().map(function (n) { return n + ' = ' + M.fmt(state.params[n].v, 4); });
    return { rows: rows.length ? rows : [{ text: 'No functions' }], note: used.length ? used.join('   ') : '' };
  }
  function renderExport() {
    var c = document.createElement('canvas');
    c.width = Math.round(W * 2); c.height = Math.round(H * 2);
    var sc = scene(true);
    sc.legend = legend();
    P.render(c.getContext('2d'), W, H, 2, sc);
    return c;
  }
  $('exportPng').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    var c = renderExport();
    c.toBlob(function (blob) {
      btn.disabled = false;
      if (!blob) { ZL.toast('Export failed. Try again.', { type: 'bad' }); return; }
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'plotline-graph.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      ZL.toast('PNG exported, ' + c.width + ' × ' + c.height + ' pixels');
    }, 'image/png');
  });
  $('copyLink').addEventListener('click', function () {
    saveNow();
    var url = location.href.split('#')[0] + currentHash();
    Promise.resolve(ZL.copy(url)).then(function (ok) {
      ZL.toast(ok ? 'Link copied to clipboard' : 'Copy failed. The link is in the address bar.', { type: ok ? 'good' : 'bad' });
    });
  });

  /* ---------- tabs ---------- */
  var TABS = ['fns', 'calc', 'table'];
  function switchTab(t, focus) {
    state.tab = t;
    TABS.forEach(function (k) {
      var on = k === t;
      $('tab-' + k).setAttribute('aria-selected', String(on));
      $('tab-' + k).tabIndex = on ? 0 : -1;
      $('panel-' + k).hidden = !on;
    });
    if (t === 'calc') { dirty.calc = true; scheduleLists(); }
    if (t === 'table') dirty.table = true;
    if (focus) $('tab-' + t).focus();
    requestDraw(); persist();
  }
  TABS.forEach(function (k, idx) {
    var b = $('tab-' + k);
    b.addEventListener('click', function () { switchTab(k); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); switchTab(TABS[(idx + 1) % 3], true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); switchTab(TABS[(idx + 2) % 3], true); }
    });
  });
  // the tour repositions on window scroll; forward the side panels' own scrolling to it
  document.querySelectorAll('.pl-panel').forEach(function (pn) {
    pn.addEventListener('scroll', function () { window.dispatchEvent(new Event('scroll')); }, { passive: true });
  });
  document.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.goto); }); });

  /* ---------- status ---------- */
  var saveText = 'Saved';
  function setStatus(s) { saveText = s; updateStatus(); }
  function updateStatus() {
    var n = state.fns.length, bad = errors.filter(Boolean).length, sl = usedParams().length;
    var parts = [n === 1 ? '1 function' : n + ' functions'];
    if (sl) parts.push(sl === 1 ? '1 slider' : sl + ' sliders');
    var play = Object.keys(playing);
    if (bad) parts.push(bad === 1 ? '1 needs fixing' : bad + ' need fixing');
    if (play.length) parts.push('Animating ' + play.join(', '));
    else parts.push(saveText);
    var text = parts.join(' · ');
    if ($('status').textContent !== text) $('status').textContent = text;
    var dot = $('statusDot');
    dot.classList.toggle('is-warn', bad > 0);
    dot.classList.toggle('is-live', play.length > 0);
  }

  /* ---------- sync controls from state ---------- */
  function syncControls() {
    $('x0').value = state.x0;
    $('intA').value = state.a; $('intB').value = state.b;
    $('optTangent').checked = state.tangent; $('optIntegral').checked = state.integral;
    $('tStart').value = state.table.start; $('tStep').value = state.table.step; $('tRows').value = state.table.rows;
    syncTools();
  }

  window.addEventListener('hashchange', function () {
    if (location.hash === currentHash()) return;
    var h = fromHash(location.hash);
    if (!h) return;
    h.table = state.table; h.tab = state.tab; h.params = Object.assign({}, state.params, h.params);
    state = sanitize(h); syncPV();
    afterBulkChange();
    ZL.toast('Graph loaded from the link', { type: 'info' });
  });

  /* ---------- theme ---------- */
  function themeChanged() { readColors(); pickerKey = ''; renderRows(); scheduleLists(); dirty.table = true; requestDraw(); }
  document.addEventListener('zl:theme', themeChanged);
  var mq = matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', themeChanged);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { requestDraw(); });

  /* ---------- init ---------- */
  loadInitial();
  readColors();
  recompile();
  syncControls();
  renderRows();
  switchTab(state.tab);
  functionsChanged();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap); else window.addEventListener('resize', resize);
  resize();
  if (state.trace && traceX == null) traceX = state.view.cx + state.view.xw / 8;
  lastHash = null;
  P.hydrateMinis(document);

  /* test and console hook: read-only view of the live state */
  window.Plotline = {
    state: function () { return JSON.parse(JSON.stringify(state)); },
    keyPoints: function () { return keyPts.slice(); },
    intersections: function () { return isects.slice(); },
    hash: currentHash,
    exportCanvas: renderExport,
    csv: tableCSV
  };

  ZL.tour([
    { el: '#fnBlock', title: 'Your functions', body: 'Type up to five functions of x. Tap the coloured letter to change its colour, drag the handle to reorder, and use the insert row for symbols like √ and π.', before: function () { switchTab('fns'); } },
    { el: '#paramArea', title: 'Sliders', body: 'Any extra letter, like a or b, gets a slider. Edit its range and step, or press play to animate it.', before: function () { switchTab('fns'); } },
    { el: '#plotWrap', title: 'The graph', body: 'Drag to pan, scroll or pinch to zoom. Tap a marked point to label it. Turn on Trace to read values under the pointer.' },
    { el: '#pointCard', title: 'Calculus', body: 'Pick a point for its value, slope and tangent, set bounds for the area, and tap any root, turning point or intersection to centre it.', before: function () { switchTab('calc'); } },
    { el: '#panel-table .pl-table-fields', title: 'Table of values', body: 'Choose a start, a step and how many rows. Copy the table as CSV for a spreadsheet.', before: function () { switchTab('table'); } },
    { el: '#shareGroup', title: 'Share and export', body: 'Copy a link that rebuilds this exact graph, or export a 2× PNG with a legend.', before: function () { switchTab('fns'); } }
  ]);
})();
