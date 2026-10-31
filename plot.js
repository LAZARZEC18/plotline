/* Plotline renderer: draws a scene (grid, curves, shading, tangent, markers,
   trace, legend) onto any 2D canvas context. Used for the live plot and for
   the 2x PNG export. Also draws the small SVG previews on the page. */
(function (root) {
  'use strict';
  var M = root.PlotlineMath;

  /* ---------- colour helpers ---------- */
  function parseColor(c) {
    c = String(c || '').trim();
    var m;
    if ((m = /^#([0-9a-f]{3,8})$/i.exec(c))) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (x) { return x + x; }).join('');
      var n = parseInt(h.slice(0, 6), 16);
      return [n >> 16 & 255, n >> 8 & 255, n & 255];
    }
    if ((m = /rgba?\(([^)]+)\)/.exec(c))) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
    return [128, 128, 128];
  }
  function rgba(c, a) { var p = parseColor(c); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + (a == null ? 1 : a) + ')'; }

  /* ---------- view maths ---------- */
  function View(v, W, H) {
    var s = W / v.xw;
    var x0 = v.cx - v.xw / 2, y1 = v.cy + H / s / 2;
    return {
      W: W, H: H, s: s,
      xMin: x0, xMax: v.cx + v.xw / 2, yMin: v.cy - H / s / 2, yMax: y1,
      px: function (x) { return (x - x0) * s; },
      py: function (y) { return (y1 - y) * s; },
      fx: function (px) { return x0 + px / s; },
      fy: function (py) { return y1 - py / s; }
    };
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function leadDigit(step) { return Math.round(step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9))); }
  function tickLabel(v, step) {
    if (Math.abs(v) < step * 1e-6) return '0';
    var a = Math.abs(v);
    if (a >= 1e6 || step < 1e-4) return M.fmt(v, 3);
    var dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return v.toFixed(dec).replace('-', '−');
  }

  var CLAMP = 1e5;
  function clampPy(py) { return py > CLAMP ? CLAMP : py < -CLAMP ? -CLAMP : py; }

  /* A big jump between neighbouring samples is a real discontinuity if it does
     not shrink when we keep halving the interval (asymptotes, steps). */
  function isBreak(f, x0, y0, x1, y1, s) {
    for (var k = 0; k < 24; k++) {
      var xm = (x0 + x1) / 2, ym = f(xm);
      if (!isFinite(ym)) return true;
      var j0 = Math.abs(ym - y0), j1 = Math.abs(y1 - ym);
      if (j0 > j1) { x1 = xm; y1 = ym; } else { x0 = xm; y0 = ym; }
      if (Math.abs(y1 - y0) * s < 1) return false;
    }
    return true;
  }

  function samplePath(V, f, stepPx, onPoint) {
    var dx = stepPx / V.s;
    var prevX = null, prevY = null, yLo = V.yMin, yHi = V.yMax, span = yHi - yLo;
    var n = Math.ceil((V.xMax - V.xMin) / dx) + 2;
    for (var k = -1; k <= n; k++) {
      var x = V.xMin + k * dx;
      var y = f(x);
      if (!isFinite(y)) { prevX = null; continue; }
      if (prevX !== null) {
        var jump = Math.abs(y - prevY) * V.s;
        var offBoth = (y > yHi && prevY > yHi) || (y < yLo && prevY < yLo);
        if (jump > 4 && !offBoth && isBreak(f, prevX, prevY, x, y, V.s)) prevX = null;
        else if (offBoth && Math.abs(y - prevY) > span * 4 && isBreak(f, prevX, prevY, x, y, V.s)) prevX = null;
      }
      onPoint(x, y, prevX === null);
      prevX = x; prevY = y;
    }
  }

  /* ---------- scene rendering ---------- */
  function render(ctx, W, H, dpr, sc) {
    var V = View(sc.view, W, H), C = sc.colors;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, V, dpr, C);
    if (sc.shade) drawShade(ctx, V, sc.shade);
    if (sc.derivative) sc.curves.forEach(function (c) {
      drawCurve(ctx, V, function (x) { return M.derivative(c.fn, x); }, c.color, 1.75, [6, 6], 0.8);
    });
    sc.curves.forEach(function (c) { drawCurve(ctx, V, c.fn, c.color, c.focused ? 3 : 2.5, null, 1); });
    drawAxisLabels(ctx, V, C);
    if (sc.tangent) drawTangent(ctx, V, sc.tangent, C);
    if (sc.points) drawMarkers(ctx, V, sc.points, sc.isects || [], C);
    if (sc.trace) drawTrace(ctx, V, sc.trace, sc.curves, C);
    if (sc.highlight) drawHighlight(ctx, V, sc.highlight, C);
    if (sc.legend) drawLegend(ctx, W, H, sc.legend, C);
  }

  function crisp(p, dpr, wDev) { return (Math.round(p * dpr) + (wDev % 2 ? 0.5 : 0)) / dpr; }

  function gridPath(ctx, V, step, dpr, wDev, skip) {
    var k, p;
    for (k = Math.ceil(V.xMin / step); k * step <= V.xMax; k++) {
      if (skip && k % skip === 0) continue;
      p = crisp(V.px(k * step), dpr, wDev); ctx.moveTo(p, 0); ctx.lineTo(p, V.H);
    }
    for (k = Math.ceil(V.yMin / step); k * step <= V.yMax; k++) {
      if (skip && k % skip === 0) continue;
      p = crisp(V.py(k * step), dpr, wDev); ctx.moveTo(0, p); ctx.lineTo(V.W, p);
    }
  }

  function drawGrid(ctx, V, dpr, C) {
    var step = niceStep(96 / V.s);
    var div = leadDigit(step) === 2 ? 4 : 5;
    var minor = step / div;
    // minor: hairlines
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = C.gridMinor;
    ctx.beginPath(); gridPath(ctx, V, minor, dpr, 1, div); ctx.stroke();
    // major
    var wMaj = Math.max(1, Math.round(dpr));
    ctx.lineWidth = wMaj / dpr;
    ctx.strokeStyle = C.gridMajor;
    ctx.beginPath(); gridPath(ctx, V, step, dpr, wMaj, 0); ctx.stroke();
    // axes
    var ax = V.px(0), ay = V.py(0), wAx = Math.max(1, Math.round(1.5 * dpr));
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = wAx / dpr;
    ctx.beginPath();
    if (ax >= 0 && ax <= V.W) { var cx = crisp(ax, dpr, wAx); ctx.moveTo(cx, 0); ctx.lineTo(cx, V.H); }
    if (ay >= 0 && ay <= V.H) { var cy = crisp(ay, dpr, wAx); ctx.moveTo(0, cy); ctx.lineTo(V.W, cy); }
    ctx.stroke();
    // tick labels
    ctx.font = '500 12px Geist, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = C.muted;
    var labelY = Math.min(Math.max(ay + 7, 8), V.H - 22);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var k = Math.ceil(V.xMin / step); k * step <= V.xMax; k++) {
      if (k === 0) continue;
      var px = V.px(k * step);
      if (px < 16 || px > V.W - 28) continue;
      halo(ctx, tickLabel(k * step, step), px, labelY, C.surface);
    }
    var right = ax - 8 >= 44;
    var labelX = right ? Math.min(ax - 8, V.W - 8) : 8;
    ctx.textAlign = right ? 'right' : 'left';
    if (ax > V.W) { ctx.textAlign = 'right'; labelX = V.W - 8; }
    ctx.textBaseline = 'middle';
    for (var j = Math.ceil(V.yMin / step); j * step <= V.yMax; j++) {
      if (j === 0) continue;
      var py = V.py(j * step);
      if (py < 28 || py > V.H - 14) continue;
      halo(ctx, tickLabel(j * step, step), labelX, py, C.surface);
    }
    if (ax >= 0 && ax <= V.W && ay >= 0 && ay <= V.H) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      halo(ctx, '0', ax - 7, ay + 7, C.surface);
    }
  }

  function drawAxisLabels(ctx, V, C) {
    var ax = V.px(0), ay = V.py(0);
    ctx.save();
    ctx.font = 'italic 600 14px Geist, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = C.ink2;
    if (ay >= 12 && ay <= V.H - 12) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; halo(ctx, 'x', V.W - 10, ay - 6, C.surface); }
    if (ax >= 12 && ax <= V.W - 12) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; halo(ctx, 'y', ax + 8, 10, C.surface); }
    ctx.restore();
  }

  function halo(ctx, t, x, y, bg) {
    ctx.save();
    ctx.lineWidth = 4; ctx.strokeStyle = bg; ctx.lineJoin = 'round';
    ctx.strokeText(t, x, y);
    ctx.restore();
    ctx.fillText(t, x, y);
  }

  function drawCurve(ctx, V, f, color, width, dash, alpha) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    samplePath(V, f, 0.75, function (x, y, start) {
      var px = V.px(x), py = clampPy(V.py(y));
      if (start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawShade(ctx, V, sh) {
    var f = sh.fn, a = Math.max(Math.min(sh.a, sh.b), V.xMin), b = Math.min(Math.max(sh.a, sh.b), V.xMax);
    var y0 = clampPy(V.py(0));
    if (b > a) {
      ctx.save();
      ctx.fillStyle = rgba(sh.color, 0.2);
      var n = Math.max(2, Math.ceil((b - a) * V.s / 1.5));
      var open = false, lastPx = 0;
      ctx.beginPath();
      for (var k = 0; k <= n; k++) {
        var x = a + (b - a) * k / n, y = f(x), px = V.px(x);
        if (!isFinite(y)) {
          if (open) { ctx.lineTo(lastPx, y0); ctx.closePath(); open = false; }
          continue;
        }
        if (!open) { ctx.moveTo(px, y0); open = true; }
        ctx.lineTo(px, clampPy(V.py(y)));
        lastPx = px;
      }
      if (open) { ctx.lineTo(lastPx, y0); ctx.closePath(); }
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = rgba(sh.color, 0.75);
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    [sh.a, sh.b].forEach(function (x) {
      var px = V.px(x), y = f(x);
      if (px < 0 || px > V.W) return;
      var top = isFinite(y) ? clampPy(V.py(y)) : 0;
      ctx.moveTo(Math.round(px) + 0.5, Math.min(top, y0)); ctx.lineTo(Math.round(px) + 0.5, Math.max(top, y0));
    });
    ctx.stroke();
    ctx.restore();
  }

  function dot(ctx, x, y, r, fill, ring, ringW) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    if (ring) { ctx.lineWidth = ringW || 2; ctx.strokeStyle = ring; ctx.stroke(); }
  }

  function drawTangent(ctx, V, t, C) {
    if (!isFinite(t.y)) return;
    var px = V.px(t.x), py = V.py(t.y);
    if (px < -200 || px > V.W + 200 || py < -200 || py > V.H + 200) return;
    if (isFinite(t.m)) {
      // a segment 260px long, centred on the point, in the function's colour
      var len = 130 / Math.sqrt(1 + t.m * t.m);
      ctx.save();
      ctx.strokeStyle = t.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.setLineDash([1, 6]);
      ctx.beginPath();
      ctx.moveTo(px - len, py + t.m * len);
      ctx.lineTo(px + len, py - t.m * len);
      ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = rgba(t.color, 0.18);
    ctx.beginPath(); ctx.arc(px, py, 13, 0, Math.PI * 2); ctx.fill();
    dot(ctx, px, py, 6.5, t.color, C.surface, 2.5);
    ctx.restore();
  }

  function drawMarkers(ctx, V, pts, isects, C) {
    ctx.save();
    pts.forEach(function (p) {
      var px = V.px(p.x), py = V.py(p.y);
      if (px < -8 || px > V.W + 8 || py < -8 || py > V.H + 8) return;
      if (p.kind === 'root') dot(ctx, px, py, 4.75, C.surface, p.color, 2.5);
      else dot(ctx, px, py, 4.5, p.color, C.surface, 2);
    });
    isects.forEach(function (p) {
      var px = V.px(p.x), py = V.py(p.y);
      if (px < -8 || px > V.W + 8 || py < -8 || py > V.H + 8) return;
      dot(ctx, px, py, 5, C.ink, C.surface, 2.5);
    });
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawHighlight(ctx, V, h, C) {
    var px = V.px(h.x), py = V.py(h.y);
    if (px < -20 || px > V.W + 20 || py < -20 || py > V.H + 20) return;
    ctx.save();
    var t = h.t == null ? 1 : h.t;
    ctx.strokeStyle = rgba(h.color, 0.45 * (1 - t) + 0.25);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 10 + 10 * t, 0, Math.PI * 2); ctx.stroke();
    dot(ctx, px, py, 6, h.color, C.surface, 2.5);
    ctx.font = '600 13px Geist, -apple-system, system-ui, sans-serif';
    var label = h.label, tw = ctx.measureText(label).width, bw = tw + 20, bh = 28;
    var bx = Math.min(Math.max(px - bw / 2, 8), V.W - bw - 8), by = py - bh - 16;
    if (by < 8) by = py + 16;
    ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
    ctx.fillStyle = C.raised; roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 10, by + bh / 2 + 0.5);
    ctx.restore();
  }

  function drawTrace(ctx, V, tr, curves, C) {
    var px = V.px(tr.x);
    if (px < 0 || px > V.W) return;
    ctx.save();
    ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, V.H); ctx.stroke();
    ctx.restore();
    curves.forEach(function (c) {
      var y = c.fn(tr.x);
      if (!isFinite(y)) return;
      var py = V.py(y);
      if (py < -10 || py > V.H + 10) return;
      var m = M.derivative(c.fn, tr.x);
      if (isFinite(m)) {
        var len = 56 / Math.sqrt(1 + m * m);
        ctx.save();
        ctx.strokeStyle = c.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(px - len, py + m * len); ctx.lineTo(px + len, py - m * len); ctx.stroke();
        ctx.restore();
      }
      dot(ctx, px, py, 5.5, c.color, C.surface, 2);
    });
  }

  function drawLegend(ctx, W, H, lg, C) {
    ctx.save();
    var rows = lg.rows, pad = 14, lh = 24;
    ctx.font = '500 14px Geist, -apple-system, system-ui, sans-serif';
    var w = 0;
    rows.forEach(function (r) { w = Math.max(w, ctx.measureText(r.text).width + (r.color ? 30 : 0)); });
    if (lg.note) { ctx.font = '500 12px Geist, -apple-system, system-ui, sans-serif'; w = Math.max(w, ctx.measureText(lg.note).width); }
    w = Math.min(w + pad * 2, W - 32);
    var h = rows.length * lh + pad * 2 - 6 + (lg.note ? 22 : 0);
    var x = 16, y = 16;
    ctx.shadowColor = 'rgba(0,0,0,.12)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    ctx.fillStyle = rgba(C.raised, 0.94); roundRect(ctx, x, y, w, h, 12); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    rows.forEach(function (r, i) {
      var cy = y + pad + i * lh + 6;
      ctx.font = '500 14px Geist, -apple-system, system-ui, sans-serif';
      if (r.color) {
        ctx.strokeStyle = r.color; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x + pad, cy); ctx.lineTo(x + pad + 18, cy); ctx.stroke();
      }
      ctx.fillStyle = C.ink;
      ctx.fillText(r.text, x + pad + (r.color ? 28 : 0), cy, w - pad * 2 - (r.color ? 28 : 0));
    });
    if (lg.note) {
      ctx.font = '500 12px Geist, -apple-system, system-ui, sans-serif';
      ctx.fillStyle = C.muted;
      ctx.fillText(lg.note, x + pad, y + h - pad - 2, w - pad * 2);
    }
    // wordmark
    ctx.font = '600 13px Geist, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('Plotline', W - 14, H - 12);
    ctx.restore();
  }

  /* ---------- SVG previews ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  /* spec: { view:[x0,x1,y0,y1], curves:[{f, c, o, w}], dots, shade:[a,b], tangent:x } */
  function miniSvg(svg, spec) {
    var vb = svg.viewBox.baseVal, W = vb.width, H = vb.height;
    var x0 = spec.view[0], x1 = spec.view[1], y0 = spec.view[2], y1 = spec.view[3];
    var sx = W / (x1 - x0), sy = H / (y1 - y0);
    var X = function (x) { return (x - x0) * sx; }, Y = function (y) { return (y1 - y) * sy; };
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var g = el('g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    svg.appendChild(g);
    // axes
    var axes = '';
    if (y0 < 0 && y1 > 0) axes += 'M0 ' + Y(0).toFixed(1) + 'H' + W;
    if (x0 < 0 && x1 > 0) axes += 'M' + X(0).toFixed(1) + ' 0V' + H;
    if (axes) g.appendChild(el('path', { d: axes, class: 'pl-mini-axis', 'stroke-width': 1.25, 'vector-effect': 'non-scaling-stroke' }));
    (spec.curves || []).forEach(function (cv, idx) {
      var c = M.compile(cv.f, spec.params || {});
      if (!c.ok) return;
      var f = c.fn, d = '', pen = false, n = 320, py0 = null;
      if (idx === 0 && spec.shade) {
        var a = spec.shade[0], b = spec.shade[1], sd = 'M' + X(a).toFixed(1) + ' ' + Y(0).toFixed(1);
        for (var k = 0; k <= 80; k++) { var xx = a + (b - a) * k / 80; sd += 'L' + X(xx).toFixed(1) + ' ' + Y(f(xx)).toFixed(1); }
        sd += 'L' + X(b).toFixed(1) + ' ' + Y(0).toFixed(1) + 'Z';
        g.appendChild(el('path', { d: sd, class: 'pl-mini-shade pl-c' + cv.c }));
      }
      for (var i = 0; i <= n; i++) {
        var x = x0 + (x1 - x0) * i / n, y = f(x), py = Y(y);
        if (!isFinite(y) || py < -H * 2 || py > H * 3 || (py0 !== null && Math.abs(py - py0) > H)) { pen = false; py0 = isFinite(y) ? py : null; if (!isFinite(y)) continue; }
        d += (pen ? 'L' : 'M') + X(x).toFixed(1) + ' ' + py.toFixed(1);
        pen = true; py0 = py;
      }
      var p = el('path', { d: d, class: 'pl-mini-curve pl-c' + cv.c, 'stroke-width': cv.w || 2.5, 'vector-effect': 'non-scaling-stroke' });
      if (cv.o != null) p.setAttribute('opacity', cv.o);
      g.appendChild(p);
      if (idx === 0 && spec.tangent != null) {
        var t = spec.tangent, ty = f(t), m = M.derivative(f, t);
        g.appendChild(el('path', { d: 'M' + X(x0) + ' ' + Y(ty + m * (x0 - t)) + 'L' + X(x1) + ' ' + Y(ty + m * (x1 - t)), class: 'pl-mini-tan', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
        g.appendChild(el('circle', { cx: X(t), cy: Y(ty), r: 5.5, class: 'pl-mini-dot pl-c' + cv.c }));
      }
    });
    (spec.dots || []).forEach(function (d) {
      g.appendChild(el('circle', { cx: X(d[0]), cy: Y(d[1]), r: 5, class: 'pl-mini-isect' }));
    });
  }
  function hydrateMinis(scope) {
    Array.prototype.forEach.call((scope || document).querySelectorAll('svg.pl-mini[data-curves]'), function (svg) {
      try {
        miniSvg(svg, {
          view: svg.getAttribute('data-view').split(',').map(Number),
          curves: JSON.parse(svg.getAttribute('data-curves')),
          dots: svg.hasAttribute('data-dots') ? JSON.parse(svg.getAttribute('data-dots')) : null,
          shade: svg.hasAttribute('data-shade') ? JSON.parse(svg.getAttribute('data-shade')) : null,
          tangent: svg.hasAttribute('data-tangent') ? Number(svg.getAttribute('data-tangent')) : null
        });
      } catch (e) { /* decorative only */ }
    });
  }

  root.PlotlinePlot = {
    View: View, niceStep: niceStep, tickLabel: tickLabel, render: render, rgba: rgba, parseColor: parseColor,
    miniSvg: miniSvg, hydrateMinis: hydrateMinis
  };
})(window);
