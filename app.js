(function () {
  'use strict';
  var M = window.PlotlineMath;
  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'plotline:state';
  var NAMES = ['f', 'g', 'h'];
  var SUB = ['₁', '₂', '₃'];
  var DEFAULT_VIEW = { cx: 0, cy: 0, xw: 20 };
  var EXAMPLES = ['sin(x)*x', 'x^3 - 3x', 'e^(-x^2)', 'ln(x)', 'tan(x)', '1/x', 'abs(x)', 'sqrt(x)', '3sin(2x)', 'x^2 - 4'];

  var state = {
    fns: [{ src: 'sin(x)*x', visible: true }],
    view: Object.assign({}, DEFAULT_VIEW),
    derivative: false, roots: false, integral: false, trace: false,
    a: '0', b: '1', focus: 0
  };
  var compiled = [];
  var traceX = null;

  /* ---------- persistence ---------- */
  function snapshot() {
    return {
      fns: state.fns.map(function (f) { return f.src; }),
      view: state.view, derivative: state.derivative, roots: state.roots,
      integral: state.integral, trace: state.trace, a: state.a, b: state.b, focus: state.focus
    };
  }
  function applySnapshot(s, hidden) {
    state.fns = s.fns.slice(0, 3).map(function (src, i) {
      return { src: String(src), visible: !(hidden && hidden[i] === false) };
    });
    if (!state.fns.length) state.fns = [{ src: 'sin(x)*x', visible: true }];
    state.view = s.view ? { cx: s.view.cx, cy: s.view.cy, xw: s.view.xw } : Object.assign({}, DEFAULT_VIEW);
    ['derivative', 'roots', 'integral', 'trace'].forEach(function (k) { state[k] = !!s[k]; });
    state.a = typeof s.a === 'string' ? s.a : '0';
    state.b = typeof s.b === 'string' ? s.b : '1';
    state.focus = s.focus >= 0 && s.focus < state.fns.length ? s.focus : 0;
  }
  var saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var hash = M.encodeState(snapshot());
      if (location.hash !== hash) {
        try { history.replaceState(null, '', hash); } catch (e) { location.hash = hash; }
      }
      try {
        var s = snapshot();
        s.visible = state.fns.map(function (f) { return f.visible; });
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch (e) { /* ignore */ }
    }, 150);
  }
  function loadInitial() {
    var fromHash = M.decodeState(location.hash);
    if (fromHash) { applySnapshot(fromHash); return; }
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && Array.isArray(s.fns) && s.fns.length) {
        var v = s.view;
        if (!(v && isFinite(v.cx) && isFinite(v.cy) && v.xw > 0)) s.view = null;
        applySnapshot(s, s.visible);
      }
    } catch (e) { /* keep defaults */ }
  }

  /* ---------- colours ---------- */
  var colors = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['surface', 'ink', 'muted', 'line', 'grid', 'grid-major', 'axis', 'f1', 'f2', 'f3'].forEach(function (k) {
      colors[k] = cs.getPropertyValue('--' + k).trim();
    });
  }
  function fnColor(i) { return colors['f' + (i + 1)]; }
  function withAlpha(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- canvas setup ---------- */
  var canvas = $('plot'), ctx = canvas.getContext('2d'), wrap = $('canvasWrap');
  var W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, canvas.clientWidth);
    H = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap);
  else window.addEventListener('resize', resize);

  function scale() { return W / state.view.xw; } // px per unit, same on both axes
  function xMin() { return state.view.cx - state.view.xw / 2; }
  function xMax() { return state.view.cx + state.view.xw / 2; }
  function yMin() { return state.view.cy - H / scale() / 2; }
  function yMax() { return state.view.cy + H / scale() / 2; }
  function toPx(x) { return (x - xMin()) * scale(); }
  function toPy(y) { return (yMax() - y) * scale(); }
  function fromPx(px) { return xMin() + px / scale(); }
  function fromPy(py) { return yMax() - py / scale(); }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function tickLabel(v, step) {
    if (Math.abs(v) < step * 1e-6) return '0';
    var a = Math.abs(v);
    if (a >= 1e6 || step < 1e-4) return M.fmt(v, 3);
    var dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return v.toFixed(dec).replace('-', '−');
  }

  /* ---------- drawing ---------- */
  var raf = 0;
  function draw() {
    if (!raf) raf = requestAnimationFrame(function () { raf = 0; render(); });
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    if (state.integral) drawIntegral();
    compiled.forEach(function (c, i) {
      if (!c || !state.fns[i].visible) return;
      if (state.derivative) {
        drawCurve(function (x) { return M.derivative(c.fn, x); }, fnColor(i), 1.75, [7, 6], 0.85);
      }
    });
    compiled.forEach(function (c, i) {
      if (!c || !state.fns[i].visible) return;
      drawCurve(c.fn, fnColor(i), i === state.focus ? 3 : 2.5, null, 1);
    });
    if (state.roots) drawPoints();
    if (state.trace && traceX != null) drawTrace();
  }

  function drawGrid() {
    var s = scale();
    var step = niceStep(90 / s), minor = step / (String(step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9)))[0] === '2' ? 4 : 5);
    ctx.lineWidth = 1;
    // minor
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    gridLines(minor);
    ctx.stroke();
    // major
    ctx.strokeStyle = colors['grid-major'];
    ctx.beginPath();
    gridLines(step);
    ctx.stroke();
    // axes
    var ax = toPx(0), ay = toPy(0);
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (ax >= 0 && ax <= W) { ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, H); }
    if (ay >= 0 && ay <= H) { ctx.moveTo(0, Math.round(ay) + 0.5); ctx.lineTo(W, Math.round(ay) + 0.5); }
    ctx.stroke();
    // labels
    ctx.font = '500 12px "Instrument Sans", system-ui, sans-serif';
    ctx.fillStyle = colors.muted;
    var labelY = Math.min(Math.max(ay + 6, 6), H - 20);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var x0 = Math.ceil(xMin() / step);
    for (var k = x0; k * step <= xMax(); k++) {
      var x = k * step;
      if (k === 0) continue;
      var px = toPx(x);
      if (px < 14 || px > W - 60) continue;
      drawLabel(tickLabel(x, step), px, labelY);
    }
    var labelX = Math.min(Math.max(ax - 6, 40), W - 6);
    var alignRight = ax - 6 >= 40;
    ctx.textAlign = alignRight ? 'right' : 'left';
    if (!alignRight) labelX = 6;
    if (ax > W - 6) { ctx.textAlign = 'right'; labelX = W - 62; }
    ctx.textBaseline = 'middle';
    var y0 = Math.ceil(yMin() / step);
    for (var j = y0; j * step <= yMax(); j++) {
      if (j === 0) continue;
      var py = toPy(j * step);
      if (py < 10 || py > H - 10) continue;
      drawLabel(tickLabel(j * step, step), labelX, py);
    }
    if (ax >= 0 && ax <= W && ay >= 0 && ay <= H) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      drawLabel('0', ax - 6, ay + 6);
    }
  }
  function drawLabel(t, x, y) {
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = colors.surface;
    ctx.lineJoin = 'round';
    ctx.strokeText(t, x, y);
    ctx.restore();
    ctx.fillText(t, x, y);
  }
  function gridLines(step) {
    var k, p;
    for (k = Math.ceil(xMin() / step); k * step <= xMax(); k++) {
      p = Math.round(toPx(k * step)) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, H);
    }
    for (k = Math.ceil(yMin() / step); k * step <= yMax(); k++) {
      p = Math.round(toPy(k * step)) + 0.5; ctx.moveTo(0, p); ctx.lineTo(W, p);
    }
  }

  var CLAMP = 1e5;
  function clampPy(py) { return py > CLAMP ? CLAMP : py < -CLAMP ? -CLAMP : py; }

  /* A big jump between neighbouring samples is a real discontinuity if it does
     not shrink when we keep halving the interval (asymptotes, steps). */
  function isBreak(f, x0, y0, x1, y1) {
    var s = scale();
    for (var k = 0; k < 24; k++) {
      var xm = (x0 + x1) / 2, ym = f(xm);
      if (!isFinite(ym)) return true;
      var j0 = Math.abs(ym - y0), j1 = Math.abs(y1 - ym);
      if (j0 > j1) { x1 = xm; y1 = ym; } else { x0 = xm; y0 = ym; }
      if (Math.abs(y1 - y0) * s < 1) return false;
    }
    return true;
  }

  function samplePath(f, step, onPoint, onBreak) {
    var xs = xMin(), xe = xMax();
    var dx = step / scale();
    var prevX = null, prevY = null, yLo = yMin(), yHi = yMax(), span = yHi - yLo;
    for (var x = xs - dx; x <= xe + dx; x += dx) {
      var y = f(x);
      if (!isFinite(y)) { if (prevX !== null) onBreak(); prevX = null; continue; }
      if (prevX !== null) {
        var jump = Math.abs(y - prevY) * scale();
        var offBoth = (y > yHi && prevY > yHi) || (y < yLo && prevY < yLo);
        if (jump > 4 && !offBoth && isBreak(f, prevX, prevY, x, y)) { onBreak(); prevX = null; }
        else if (offBoth && Math.abs(y - prevY) > span * 4 && isBreak(f, prevX, prevY, x, y)) { onBreak(); prevX = null; }
      }
      onPoint(x, y, prevX === null);
      prevX = x; prevY = y;
    }
  }

  function drawCurve(f, color, width, dash, alpha) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    samplePath(f, 0.75, function (x, y, start) {
      var px = toPx(x), py = clampPy(toPy(y));
      if (start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }, function () {});
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- integral ---------- */
  var integralInfo = null;
  function integralFn() {
    var c = compiled[state.focus];
    return c && state.fns[state.focus].visible ? c : null;
  }
  function computeIntegral() {
    integralInfo = null;
    var err = $('intError'), out = $('intOut'), aIn = $('intA'), bIn = $('intB');
    aIn.removeAttribute('aria-invalid'); bIn.removeAttribute('aria-invalid');
    var name = NAMES[state.focus];
    $('intLabel').textContent = 'Area under ' + name + '(x) from ' + (state.a || 'a') + ' to ' + (state.b || 'b') + ', signed';
    var c = integralFn();
    var A = M.evalConstant(state.a), B = M.evalConstant(state.b);
    var msg = '';
    if (!c) msg = 'Pick a visible function with no errors to integrate.';
    else if (!A.ok) { msg = 'a: ' + A.error; aIn.setAttribute('aria-invalid', 'true'); }
    else if (!B.ok) { msg = 'b: ' + B.error; bIn.setAttribute('aria-invalid', 'true'); }
    var res = null;
    if (!msg) {
      res = M.simpson(c.fn, A.value, B.value, 4000);
      if (!res.ok) msg = res.error;
    }
    if (msg) { err.textContent = msg; err.hidden = false; out.textContent = '–'; out.dataset.value = ''; return; }
    err.hidden = true;
    out.textContent = M.fmt(res.value, 7);
    out.dataset.value = String(res.value);
    integralInfo = { a: Math.min(A.value, B.value), b: Math.max(A.value, B.value), fn: c.fn };
  }
  function drawIntegral() {
    if (!integralInfo) return;
    var f = integralInfo.fn, a = Math.max(integralInfo.a, xMin()), b = Math.min(integralInfo.b, xMax());
    var color = fnColor(state.focus);
    if (b > a) {
      ctx.save();
      ctx.fillStyle = withAlpha(color, 0.2);
      var y0 = clampPy(toPy(0));
      var n = Math.max(2, Math.ceil((b - a) * scale() / 1.5));
      var open = false;
      ctx.beginPath();
      for (var k = 0; k <= n; k++) {
        var x = a + (b - a) * k / n, y = f(x);
        var px = toPx(x);
        if (!isFinite(y)) {
          if (open) { ctx.lineTo(toPx(a + (b - a) * (k - 1) / n), y0); ctx.closePath(); open = false; }
          continue;
        }
        var py = clampPy(toPy(y));
        if (!open) { ctx.moveTo(px, y0); open = true; }
        ctx.lineTo(px, py);
        if (k === n) { ctx.lineTo(px, y0); ctx.closePath(); }
      }
      ctx.fill();
      ctx.restore();
    }
    // bounds
    ctx.save();
    ctx.strokeStyle = withAlpha(color, 0.7);
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    [integralInfo.a, integralInfo.b].forEach(function (x) {
      var px = toPx(x);
      if (px >= 0 && px <= W) { ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); }
    });
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- roots and turning points ---------- */
  var points = [];
  function computePoints() {
    points = compiled.map(function (c, i) {
      if (!c || !state.fns[i].visible) return null;
      return {
        roots: M.findRoots(c.fn, xMin(), xMax(), 1000),
        extrema: M.findExtrema(c.fn, xMin(), xMax(), 1000)
      };
    });
  }
  function drawPoints() {
    points.forEach(function (p, i) {
      if (!p) return;
      var color = fnColor(i);
      ctx.save();
      ctx.lineWidth = 2.5;
      p.roots.forEach(function (x) {
        var px = toPx(x), py = toPy(0);
        ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.surface; ctx.fill();
        ctx.strokeStyle = color; ctx.stroke();
      });
      p.extrema.forEach(function (e) {
        var px = toPx(e.x), py = toPy(e.y);
        if (py < -10 || py > H + 10) return;
        ctx.beginPath();
        var d = 6.5, dir = e.kind === 'max' ? -1 : 1;
        ctx.moveTo(px, py + dir * d * 1.1);
        ctx.lineTo(px - d, py - dir * d * 0.7);
        ctx.lineTo(px + d, py - dir * d * 0.7);
        ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = colors.surface; ctx.lineWidth = 1.5; ctx.stroke();
      });
      ctx.restore();
    });
  }
  function listText(arr, fmtOne) {
    var shown = arr.slice(0, 5).map(fmtOne).join(', ');
    return arr.length > 5 ? shown + ' and ' + (arr.length - 5) + ' more' : shown;
  }
  var pointsTimer = null;
  function renderPointsList() {
    clearTimeout(pointsTimer);
    pointsTimer = setTimeout(function () {
      var out = $('pointsOut');
      out.textContent = '';
      var any = false;
      points.forEach(function (p, i) {
        if (!p) return;
        any = true;
        var g = document.createElement('div');
        g.className = 'pt-group';
        g.style.setProperty('--fn', fnColor(i));
        g.dataset.roots = JSON.stringify(p.roots);
        var maxes = p.extrema.filter(function (e) { return e.kind === 'max'; });
        var mins = p.extrema.filter(function (e) { return e.kind === 'min'; });
        var pt = function (e) { return '(' + M.fmt(e.x, 4) + ', ' + M.fmt(e.y, 4) + ')'; };
        g.innerHTML = '<h3>' + NAMES[i] + '(x)</h3>' +
          '<p>Roots: <b>' + (p.roots.length ? listText(p.roots, function (x) { return 'x = ' + M.fmt(x, 5); }) : 'none in view') + '</b></p>' +
          '<p>Local max: <b>' + (maxes.length ? listText(maxes, pt) : 'none in view') + '</b></p>' +
          '<p>Local min: <b>' + (mins.length ? listText(mins, pt) : 'none in view') + '</b></p>';
        out.appendChild(g);
      });
      if (!any) out.innerHTML = '<p class="help">Add a visible function to see its roots and turning points.</p>';
    }, 120);
  }

  /* ---------- trace ---------- */
  function drawTrace() {
    var px = toPx(traceX);
    if (px < 0 || px > W) return;
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke();
    ctx.restore();
    compiled.forEach(function (c, i) {
      if (!c || !state.fns[i].visible) return;
      var y = c.fn(traceX);
      if (!isFinite(y)) return;
      var py = toPy(y);
      if (py < -10 || py > H + 10) return;
      var m = M.derivative(c.fn, traceX);
      if (isFinite(m)) {
        // tangent segment, 120px long
        var len = 60 / Math.sqrt(1 + m * m);
        ctx.save();
        ctx.strokeStyle = fnColor(i);
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px - len, py + m * len);
        ctx.lineTo(px + len, py - m * len);
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = fnColor(i); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = colors.surface; ctx.stroke();
    });
  }
  function updateTraceBox() {
    var box = $('traceBox');
    if (!state.trace || traceX == null) { box.hidden = true; return; }
    var html = '<div class="tx">x = ' + M.fmt(traceX, 5) + '</div>';
    compiled.forEach(function (c, i) {
      if (!c || !state.fns[i].visible) return;
      var y = c.fn(traceX), m = M.derivative(c.fn, traceX);
      html += '<div data-fn="' + i + '" data-y="' + y + '" data-slope="' + m + '"><span class="dot" style="background:' + fnColor(i) + '"></span>' +
        NAMES[i] + '(x) = ' + M.fmt(y, 5) + ' <span class="slope">slope ' + M.fmt(m, 4) + '</span></div>';
    });
    box.innerHTML = html;
    box.hidden = false;
  }

  /* ---------- view changes ---------- */
  function viewChanged() {
    if (state.roots) { computePoints(); renderPointsList(); }
    draw();
    updateTraceBox();
    persist();
  }
  function zoomAt(factor, px, py) {
    var v = state.view;
    var newW = Math.min(1e7, Math.max(1e-6, v.xw * factor));
    factor = newW / v.xw;
    var x = fromPx(px), y = fromPy(py);
    v.cx = x + (v.cx - x) * factor;
    v.cy = y + (v.cy - y) * factor;
    v.xw = newW;
    viewChanged();
  }
  function panBy(dpx, dpy) {
    state.view.cx -= dpx / scale();
    state.view.cy += dpy / scale();
    viewChanged();
  }

  $('zoomIn').addEventListener('click', function () { zoomAt(1 / 1.5, W / 2, H / 2); });
  $('zoomOut').addEventListener('click', function () { zoomAt(1.5, W / 2, H / 2); });
  $('resetView').addEventListener('click', function () { state.view = Object.assign({}, DEFAULT_VIEW); viewChanged(); });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    var d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(d * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  var pointers = new Map(), pinch = null, lastPan = null;
  function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function setTraceFromPx(px) {
    traceX = fromPx(px);
    draw(); updateTraceBox();
  }
  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
      lastPan = null;
    } else if (pointers.size === 1) {
      var p = local(e);
      // with trace on, a finger traces; mouse and pen still pan by dragging
      if (state.trace && e.pointerType === 'touch') { lastPan = null; setTraceFromPx(p.x); }
      else { lastPan = p; canvas.classList.add('dragging'); }
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      state.view.cx -= (mx - pinch.mx) / scale();
      state.view.cy += (my - pinch.my) / scale();
      if (d > 10 && pinch.d > 10) zoomAt(pinch.d / d, mx, my); else viewChanged();
      pinch = { d: d, mx: mx, my: my };
      return;
    }
    if (lastPan && pointers.has(e.pointerId)) {
      panBy(p.x - lastPan.x, p.y - lastPan.y);
      lastPan = p;
      return;
    }
    if (state.trace && (e.pointerType !== 'touch' || pointers.has(e.pointerId))) setTraceFromPx(p.x);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { lastPan = null; canvas.classList.remove('dragging'); }
    else if (pointers.size === 1 && !(state.trace && e.pointerType === 'touch')) lastPan = Array.from(pointers.values())[0];
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('keydown', function (e) {
    var step = 40;
    var handled = true;
    if (e.key === 'ArrowLeft') panBy(step, 0);
    else if (e.key === 'ArrowRight') panBy(-step, 0);
    else if (e.key === 'ArrowUp') panBy(0, step);
    else if (e.key === 'ArrowDown') panBy(0, -step);
    else if (e.key === '+' || e.key === '=') zoomAt(1 / 1.25, W / 2, H / 2);
    else if (e.key === '-' || e.key === '_') zoomAt(1.25, W / 2, H / 2);
    else if (e.key === '0') { state.view = Object.assign({}, DEFAULT_VIEW); viewChanged(); }
    else handled = false;
    if (handled) e.preventDefault();
  });

  /* ---------- function rows ---------- */
  var fnList = $('fnList');
  function recompile() {
    compiled = state.fns.map(function (f) {
      var c = M.compile(f.src);
      return c.ok ? c : null;
    });
  }
  function renderRows() {
    fnList.textContent = '';
    state.fns.forEach(function (f, i) {
      var li = document.createElement('li');
      li.className = 'fn-row' + (i === state.focus ? ' is-selected' : '') + (f.visible ? '' : ' is-hidden');
      li.style.setProperty('--fn', fnColor(i));
      var id = 'fn' + i;
      li.innerHTML =
        '<label class="fn-name" for="' + id + '">' + NAMES[i] + '(x) =</label>' +
        '<input id="' + id + '" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. x^2 - 4" aria-describedby="' + id + 'err">' +
        '<button type="button" class="icon-btn plain vis" aria-pressed="' + (!f.visible) + '" aria-label="' + (f.visible ? 'Hide ' : 'Show ') + NAMES[i] + '(x)">' +
        '<svg class="eye-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' +
        '<svg class="eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg></button>' +
        '<button type="button" class="icon-btn plain del" aria-label="Remove ' + NAMES[i] + '(x)"' + (state.fns.length < 2 ? ' disabled hidden' : '') + '>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '<p class="error" id="' + id + 'err" role="alert" hidden></p>';
      var input = li.querySelector('input');
      input.value = f.src;
      input.addEventListener('input', function () {
        f.src = input.value;
        recompile(); showRowError(i, li);
        refresh();
      });
      input.addEventListener('focus', function () { setFocus(i); });
      li.querySelector('.vis').addEventListener('click', function () {
        f.visible = !f.visible;
        renderRows(); refresh();
        fnList.querySelectorAll('.vis')[i].focus();
      });
      li.querySelector('.del').addEventListener('click', function () {
        state.fns.splice(i, 1);
        if (state.focus >= state.fns.length) state.focus = state.fns.length - 1;
        else if (state.focus > i) state.focus--;
        recompile(); renderRows(); refresh();
        var inputs = fnList.querySelectorAll('input');
        inputs[Math.min(i, inputs.length - 1)].focus();
      });
      fnList.appendChild(li);
      showRowError(i, li);
    });
    $('addFn').disabled = state.fns.length >= 3;
    $('addFn').textContent = state.fns.length >= 3 ? 'Three functions is the limit' : 'Add function';
    renderIntSelect();
  }
  function showRowError(i, li) {
    var f = state.fns[i], err = li.querySelector('.error'), input = li.querySelector('input');
    if (!f.src.trim()) {
      err.hidden = true; li.removeAttribute('data-invalid'); input.removeAttribute('aria-invalid');
      return;
    }
    var c = M.compile(f.src);
    if (c.ok) { err.hidden = true; li.removeAttribute('data-invalid'); input.removeAttribute('aria-invalid'); }
    else { err.textContent = c.error; err.hidden = false; li.setAttribute('data-invalid', 'true'); input.setAttribute('aria-invalid', 'true'); }
  }
  function setFocus(i) {
    if (state.focus === i) return;
    state.focus = i;
    fnList.querySelectorAll('.fn-row').forEach(function (r, k) { r.classList.toggle('is-selected', k === i); });
    $('intFn').value = String(i);
    refresh();
  }
  $('addFn').addEventListener('click', function () {
    if (state.fns.length >= 3) return;
    state.fns.push({ src: '', visible: true });
    state.focus = state.fns.length - 1;
    recompile(); renderRows(); refresh();
    fnList.querySelectorAll('input')[state.focus].focus();
  });

  function renderIntSelect() {
    var sel = $('intFn');
    sel.textContent = '';
    state.fns.forEach(function (f, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = NAMES[i] + '(x)';
      sel.appendChild(o);
    });
    sel.value = String(state.focus);
  }
  $('intFn').addEventListener('change', function () { setFocus(Number(this.value)); });

  /* ---------- examples ---------- */
  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = ex;
    b.setAttribute('aria-label', 'Load ' + ex);
    b.addEventListener('click', function () {
      var f = state.fns[state.focus];
      f.src = ex; f.visible = true;
      recompile(); renderRows(); refresh();
    });
    $('examples').appendChild(b);
  });

  /* ---------- overlays ---------- */
  var opts = { optDeriv: 'derivative', optRoots: 'roots', optInt: 'integral', optTrace: 'trace' };
  Object.keys(opts).forEach(function (id) {
    $(id).addEventListener('change', function () {
      state[opts[id]] = this.checked;
      if (id === 'optTrace') {
        canvas.classList.toggle('tracing', this.checked);
        if (this.checked && traceX == null) traceX = state.view.cx + state.view.xw / 8;
      }
      refresh();
    });
  });
  ['intA', 'intB'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      state[id === 'intA' ? 'a' : 'b'] = this.value;
      refresh();
    });
  });

  function syncControls() {
    $('optDeriv').checked = state.derivative;
    $('optRoots').checked = state.roots;
    $('optInt').checked = state.integral;
    $('optTrace').checked = state.trace;
    $('intA').value = state.a;
    $('intB').value = state.b;
    canvas.classList.toggle('tracing', state.trace);
    if (state.trace && traceX == null) traceX = state.view.cx + state.view.xw / 8;
  }

  function refresh() {
    $('integralPanel').hidden = !state.integral;
    $('pointsPanel').hidden = !state.roots;
    if (state.integral) computeIntegral(); else integralInfo = null;
    if (state.roots) { computePoints(); renderPointsList(); }
    var labels = state.fns.map(function (f, i) { return NAMES[i] + '(x) = ' + (f.src || 'empty'); }).join('; ');
    canvas.setAttribute('aria-label', 'Graph of ' + labels);
    draw();
    updateTraceBox();
    persist();
  }

  /* ---------- share ---------- */
  $('copyLink').addEventListener('click', function () {
    var url = location.href.split('#')[0] + M.encodeState(snapshot());
    var done = function (ok) {
      $('copied').textContent = ok ? 'Link copied.' : 'Copy failed. The link is in the address bar.';
      clearTimeout(done.t);
      done.t = setTimeout(function () { $('copied').textContent = ''; }, 2500);
    };
    try { history.replaceState(null, '', M.encodeState(snapshot())); } catch (e) { /* ignore */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  });

  window.addEventListener('hashchange', function () {
    var s = M.decodeState(location.hash);
    if (!s) return;
    if (location.hash === M.encodeState(snapshot())) return;
    applySnapshot(s);
    recompile(); syncControls(); renderRows(); refresh();
  });

  /* ---------- theme ---------- */
  var themeBtn = $('themeToggle');
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function themeChanged() {
    var t = currentTheme();
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    document.querySelectorAll('meta[name=theme-color]').forEach(function (m) { m.setAttribute('content', t === 'dark' ? '#0F161D' : '#F3F5F7'); });
    readColors();
    renderRows();
    if (state.roots) renderPointsList();
    updateTraceBox();
    draw();
  }
  themeBtn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('plotline:theme', next); } catch (e) { /* ignore */ }
    themeChanged();
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', themeChanged);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

  /* ---------- init ---------- */
  loadInitial();
  readColors();
  recompile();
  syncControls();
  renderRows();
  themeBtn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  resize();
  refresh();
})();
