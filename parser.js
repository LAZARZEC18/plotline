/* Plotline maths core: a small, safe expression parser (tokenizer + recursive
   descent), plus numeric calculus helpers. It never hands text to the JS engine. */
(function (root) {
  'use strict';

  var FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sec: function (v) { return 1 / Math.cos(v); },
    csc: function (v) { return 1 / Math.sin(v); },
    cot: function (v) { return 1 / Math.tan(v); },
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, exp: Math.exp,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign
  };
  var FUNCS2 = { min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2 };
  var CONSTS = { pi: Math.PI, 'π': Math.PI, tau: 2 * Math.PI, e: Math.E };
  var VARS = { x: true };

  var NAMES = Object.keys(FUNCS).concat(Object.keys(FUNCS2), Object.keys(CONSTS), Object.keys(VARS))
    .sort(function (a, b) { return b.length - a.length; });

  function ParseError(message, pos) {
    this.message = message;
    this.pos = pos;
  }

  function isKnown(n) { return n in FUNCS || n in FUNCS2 || n in CONSTS || n in VARS; }

  /* Split a run of letters like "xsin" or "pix" into known names, longest first. */
  function splitName(word, pos) {
    if (isKnown(word)) return [word];
    var out = [], i = 0;
    while (i < word.length) {
      var hit = null;
      for (var k = 0; k < NAMES.length; k++) {
        if (word.substr(i, NAMES[k].length) === NAMES[k]) { hit = NAMES[k]; break; }
      }
      if (!hit) {
        throw new ParseError('Unknown name "' + word + '". Use x, pi, e, or a function like sin, cos, ln, sqrt or abs.', pos);
      }
      out.push(hit);
      i += hit.length;
    }
    return out;
  }

  function tokenize(src) {
    var tokens = [], i = 0, s = String(src);
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        if (!m) throw new ParseError('A lone "." is not a number.', i);
        // "2e" followed by non-digit is 2*e, which the regex already leaves alone
        tokens.push({ type: 'num', value: parseFloat(m[0]), pos: i });
        i += m[0].length;
        continue;
      }
      if (/[a-zA-Zπ]/.test(c)) {
        var w = /^[a-zA-Zπ]+/.exec(s.slice(i))[0];
        var parts = splitName(w.toLowerCase(), i);
        var p = i;
        parts.forEach(function (n) { tokens.push({ type: 'name', value: n, pos: p }); p += n.length; });
        i += w.length;
        continue;
      }
      if (c === '*' && s[i + 1] === '*') { tokens.push({ type: 'op', value: '^', pos: i }); i += 2; continue; }
      if ('+-*/^(),|'.indexOf(c) >= 0) { tokens.push({ type: 'op', value: c, pos: i }); i++; continue; }
      if (c === '×' || c === '·') { tokens.push({ type: 'op', value: '*', pos: i }); i++; continue; }
      if (c === '÷') { tokens.push({ type: 'op', value: '/', pos: i }); i++; continue; }
      if (c === '−') { tokens.push({ type: 'op', value: '-', pos: i }); i++; continue; }
      if (c === '[' || c === '{') { tokens.push({ type: 'op', value: '(', pos: i }); i++; continue; }
      if (c === ']' || c === '}') { tokens.push({ type: 'op', value: ')', pos: i }); i++; continue; }
      throw new ParseError('Unexpected character "' + c + '" at position ' + (i + 1) + '.', i);
    }
    return tokens;
  }

  /* Grammar
     expr    := term (('+'|'-') term)*
     term    := unary (('*'|'/') unary | <implicit> power)*
     unary   := ('-'|'+') unary | power
     power   := primary ('^' unary)?          right-associative, so 2^3^2 = 2^9
     primary := num | const | x | func '(' args ')' | func primary | '(' expr ')' | '|' expr '|'
     Unary minus binds looser than ^, so -x^2 = -(x^2). */
  function parse(src) {
    var tokens = tokenize(src);
    if (!tokens.length) throw new ParseError('Type a function of x, for example sin(x) or x^2.', 0);
    var i = 0, absDepth = 0;
    function peek() { return tokens[i]; }
    function isOp(t, v) { return t && t.type === 'op' && t.value === v; }
    function expect(v, what) {
      var t = peek();
      if (!isOp(t, v)) {
        throw new ParseError(t ? 'Expected ' + what + ' at position ' + (t.pos + 1) + '.' : 'Missing ' + what + ' at the end.', t ? t.pos : String(src).length);
      }
      i++;
    }

    function expr() {
      var node = term();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        var op = tokens[i++].value;
        node = { t: 'bin', op: op, a: node, b: term() };
      }
      return node;
    }

    function startsFactor(t) {
      if (!t) return false;
      if (t.type === 'num' || t.type === 'name') return true;
      if (isOp(t, '(')) return true;
      if (isOp(t, '|') && absDepth === 0) return true;
      return false;
    }

    function term() {
      var node = unary();
      for (;;) {
        var t = peek();
        if (isOp(t, '*') || isOp(t, '/')) {
          i++;
          node = { t: 'bin', op: t.value, a: node, b: unary() };
        } else if (startsFactor(t)) {
          if (t.type === 'num' && node.t === 'num') throw new ParseError('Two numbers in a row at position ' + (t.pos + 1) + '. Add an operator between them.', t.pos);
          node = { t: 'bin', op: '*', a: node, b: power() };
        } else break;
      }
      return node;
    }

    function unary() {
      var t = peek();
      if (isOp(t, '-')) { i++; return { t: 'neg', a: unary() }; }
      if (isOp(t, '+')) { i++; return unary(); }
      return power();
    }

    function power() {
      var base = primary();
      if (isOp(peek(), '^')) {
        i++;
        return { t: 'bin', op: '^', a: base, b: unary() };
      }
      return base;
    }

    function primary() {
      var t = peek();
      if (!t) throw new ParseError('The expression ends too early. Finish it with a number or x.', String(src).length);
      if (t.type === 'num') { i++; return { t: 'num', v: t.value }; }
      if (t.type === 'name') {
        i++;
        var n = t.value;
        if (n in VARS) return { t: 'x' };
        if (n in CONSTS) return { t: 'num', v: CONSTS[n] };
        if (n in FUNCS2) {
          expect('(', '"(" after ' + n);
          var a = expr();
          expect(',', 'a comma between the two values of ' + n);
          var b = expr();
          expect(')', 'a closing ")"');
          return { t: 'f2', f: n, a: a, b: b };
        }
        // one-argument function: f(expr), or f followed by a power like sin x or sin 2x
        var arg;
        if (isOp(peek(), '(')) {
          i++;
          arg = expr();
          expect(')', 'a closing ")"');
          // allow sin(x)^2 style: power applies to the function result
          return { t: 'f1', f: n, a: arg };
        }
        if (!peek() || !startsFactor(peek())) throw new ParseError(n + ' needs an input, like ' + n + '(x).', t.pos);
        return { t: 'f1', f: n, a: power() };
      }
      if (isOp(t, '(')) {
        i++;
        var inner = expr();
        expect(')', 'a closing ")"');
        return inner;
      }
      if (isOp(t, '|')) {
        i++;
        absDepth++;
        var body = expr();
        absDepth--;
        expect('|', 'a closing "|"');
        return { t: 'f1', f: 'abs', a: body };
      }
      throw new ParseError('Unexpected "' + t.value + '" at position ' + (t.pos + 1) + '.', t.pos);
    }

    var tree = expr();
    if (i < tokens.length) {
      var t = tokens[i];
      throw new ParseError(isOp(t, ')') ? 'There is an extra ")" at position ' + (t.pos + 1) + '.' : 'Unexpected "' + t.value + '" at position ' + (t.pos + 1) + '.', t.pos);
    }
    return tree;
  }

  function build(node) {
    switch (node.t) {
      case 'num': var v = node.v; return function () { return v; };
      case 'x': return function (x) { return x; };
      case 'neg': var a0 = build(node.a); return function (x) { return -a0(x); };
      case 'f1': var f = FUNCS[node.f], a1 = build(node.a); return function (x) { return f(a1(x)); };
      case 'f2': var g = FUNCS2[node.f], a2 = build(node.a), b2 = build(node.b); return function (x) { return g(a2(x), b2(x)); };
      case 'bin':
        var l = build(node.a), r = build(node.b);
        switch (node.op) {
          case '+': return function (x) { return l(x) + r(x); };
          case '-': return function (x) { return l(x) - r(x); };
          case '*': return function (x) { return l(x) * r(x); };
          case '/': return function (x) { return l(x) / r(x); };
          case '^': return function (x) { return powReal(l(x), r(x)); };
        }
    }
    throw new Error('bad node');
  }

  /* Real power: allow odd roots of negatives, e.g. (-8)^(1/3) = -2 */
  function powReal(a, b) {
    if (a < 0 && !Number.isInteger(b)) {
      for (var q = 3; q <= 15; q += 2) {
        var p = b * q;
        if (Math.abs(p - Math.round(p)) < 1e-9) {
          var r = Math.pow(-a, b);
          return Math.round(p) % 2 === 0 ? r : -r;
        }
      }
      return NaN;
    }
    return Math.pow(a, b);
  }

  /* compile(src) -> { ok, fn, error, pos } */
  function compile(src) {
    try {
      var tree = parse(src);
      return { ok: true, fn: build(tree), tree: tree };
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: e.message, pos: e.pos };
      throw e;
    }
  }

  function evaluate(src, x) {
    var c = compile(src);
    if (!c.ok) throw new Error(c.error);
    return c.fn(x);
  }

  /* number input that may be an expression without x, like pi/2 */
  function evalConstant(src) {
    var c = compile(src);
    if (!c.ok) return { ok: false, error: c.error };
    if (usesX(c.tree)) return { ok: false, error: 'Use a number here, not x.' };
    var v = c.fn(0);
    if (!isFinite(v)) return { ok: false, error: 'That works out to an undefined number.' };
    return { ok: true, value: v };
  }
  function usesX(n) {
    if (!n) return false;
    if (n.t === 'x') return true;
    return usesX(n.a) || usesX(n.b);
  }

  /* ---------- calculus ---------- */
  function derivative(f, x) {
    var h = 1e-5 * Math.max(1, Math.abs(x));
    return (f(x + h) - f(x - h)) / (2 * h);
  }

  function simpson(f, a, b, n) {
    if (a === b) return { ok: true, value: 0 };
    n = n || 2000;
    if (n % 2) n++;
    var sign = 1;
    if (a > b) { var t = a; a = b; b = t; sign = -1; }
    var h = (b - a) / n, sum = f(a) + f(b);
    for (var k = 1; k < n; k++) sum += (k % 2 ? 4 : 2) * f(a + k * h);
    var v = sign * sum * h / 3;
    if (!isFinite(v)) return { ok: false, error: 'The integral does not converge here: the function is undefined or infinite somewhere between a and b.' };
    return { ok: true, value: v };
  }

  function bisect(g, lo, hi, glo) {
    for (var k = 0; k < 80; k++) {
      var mid = (lo + hi) / 2;
      var gm = g(mid);
      if (gm === 0) return mid;
      if ((gm < 0) === (glo < 0)) { lo = mid; glo = gm; } else hi = mid;
      if (hi - lo < 1e-13 * Math.max(1, Math.abs(mid))) break;
    }
    return (lo + hi) / 2;
  }

  function dedupe(list, tol) {
    list.sort(function (a, b) { return a - b; });
    var out = [];
    list.forEach(function (v) { if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v); });
    return out;
  }

  /* roots by sign change + bisection, rejecting asymptote sign flips (like tan or 1/x) */
  function findRoots(f, a, b, n) {
    n = n || 1200;
    var h = (b - a) / n, roots = [];
    var span = Math.abs(b - a);
    var xp = a, yp = f(a);
    if (yp === 0) roots.push(a);
    for (var k = 1; k <= n; k++) {
      var x = a + k * h, y = f(x);
      if (y === 0) roots.push(x);
      else if (isFinite(y) !== isFinite(yp)) {
        // edge of the domain (like sqrt(x) at 0): find the edge and keep it if f is ~0 there
        var lo = xp, hi = x, finLo = isFinite(yp);
        for (var it = 0; it < 60; it++) {
          var mid = (lo + hi) / 2;
          if (isFinite(f(mid)) === finLo) lo = mid; else hi = mid;
        }
        var edge = finLo ? lo : hi, fe = f(edge);
        if (isFinite(fe) && Math.abs(fe) < 1e-6) roots.push(Math.abs(edge) < 1e-9 ? 0 : edge);
      } else if (isFinite(y) && isFinite(yp) && yp !== 0 && (y < 0) !== (yp < 0)) {
        var r = bisect(f, xp, x, yp);
        var fr = f(r);
        var scale = Math.max(Math.abs(y), Math.abs(yp));
        if (isFinite(fr) && Math.abs(fr) <= Math.max(1e-7, scale * 1e-3)) roots.push(r);
      }
      xp = x; yp = y;
    }
    // touching roots like x^2 at 0: local extrema whose value is ~0
    findExtrema(f, a, b, n).forEach(function (e) {
      if (Math.abs(e.y) < 1e-9) roots.push(e.x);
    });
    return dedupe(roots, span * 1e-6).map(cleanNum);
  }

  function findExtrema(f, a, b, n) {
    n = n || 1200;
    var h = (b - a) / n, out = [];
    var d = function (x) { return derivative(f, x); };
    // remember the last sample with a non-zero slope so an exact zero (like x^2 at 0) still counts
    var xp = a, dp = d(a);
    if (dp === 0) dp = NaN;
    for (var k = 1; k <= n; k++) {
      var x = a + k * h, dx = d(x);
      if (dx === 0) continue;
      if (!isFinite(dx)) { xp = x; dp = NaN; continue; }
      if (isFinite(dp) && (dx < 0) !== (dp < 0)) {
        var r = bisect(d, xp, x, dp);
        var y = f(r), yl = f(r - h), yr = f(r + h);
        // a slope sign flip across an asymptote (like 1/x^2 at 0) leaves a huge slope at r: skip it
        var dr = Math.abs(d(r)), dScale = Math.max(Math.abs(dp), Math.abs(dx));
        var flat = isFinite(dr) && dr <= Math.max(1e-6, dScale * 0.05);
        if (flat && isFinite(y) && isFinite(yl) && isFinite(yr)) {
          if (y >= yl && y >= yr) out.push({ x: cleanNum(r), y: cleanNum(y), kind: 'max' });
          else if (y <= yl && y <= yr) out.push({ x: cleanNum(r), y: cleanNum(y), kind: 'min' });
        }
      }
      xp = x; dp = dx;
    }
    return out;
  }

  function cleanNum(v) {
    var r = Math.round(v);
    if (Math.abs(v - r) < 1e-9 * Math.max(1, Math.abs(v))) return r === 0 ? 0 : r;
    return v;
  }

  function fmt(v, sig) {
    if (!isFinite(v)) return isNaN(v) ? 'undefined' : (v > 0 ? '∞' : '−∞');
    if (v === 0) return '0';
    var a = Math.abs(v);
    var s;
    if (a >= 1e6 || a < 1e-4) {
      s = v.toExponential((sig || 4) - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
    } else {
      s = String(parseFloat(v.toPrecision(sig || 5)));
    }
    return s.replace('-', '−');
  }

  /* ---------- URL hash ---------- */
  function encodeState(st) {
    var parts = [];
    st.fns.forEach(function (f) { parts.push('f=' + encodeURIComponent(f)); });
    parts.push('v=' + [st.view.cx, st.view.cy, st.view.xw].map(function (n) { return String(Number(n.toPrecision(8))); }).join(','));
    var flags = '';
    if (st.derivative) flags += 'd';
    if (st.roots) flags += 'r';
    if (st.integral) flags += 'i';
    if (st.trace) flags += 't';
    if (flags) parts.push('o=' + flags);
    if (st.integral) parts.push('ab=' + encodeURIComponent(st.a) + ',' + encodeURIComponent(st.b));
    if (st.focus) parts.push('s=' + st.focus);
    return '#' + parts.join('&');
  }

  function decodeState(hash) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    var st = { fns: [], view: null, derivative: false, roots: false, integral: false, trace: false, a: '0', b: '1', focus: 0 };
    h.split('&').forEach(function (kv) {
      var eq = kv.indexOf('=');
      if (eq < 0) return;
      var k = kv.slice(0, eq), v = kv.slice(eq + 1);
      try {
        if (k === 'f' && st.fns.length < 3) st.fns.push(decodeURIComponent(v));
        else if (k === 'v') {
          var n = v.split(',').map(Number);
          if (n.length === 3 && n.every(isFinite) && n[2] > 0) st.view = { cx: n[0], cy: n[1], xw: n[2] };
        } else if (k === 'o') {
          st.derivative = v.indexOf('d') >= 0; st.roots = v.indexOf('r') >= 0;
          st.integral = v.indexOf('i') >= 0; st.trace = v.indexOf('t') >= 0;
        } else if (k === 'ab') {
          var ab = v.split(',');
          if (ab.length === 2) { st.a = decodeURIComponent(ab[0]); st.b = decodeURIComponent(ab[1]); }
        } else if (k === 's') {
          var s = parseInt(v, 10);
          if (s >= 0 && s <= 2) st.focus = s;
        }
      } catch (e) { /* bad escape: skip this part */ }
    });
    if (!st.fns.length) return null;
    if (st.focus >= st.fns.length) st.focus = 0;
    return st;
  }

  var api = {
    tokenize: tokenize, parse: parse, compile: compile, evaluate: evaluate, evalConstant: evalConstant,
    derivative: derivative, simpson: simpson, findRoots: findRoots, findExtrema: findExtrema,
    fmt: fmt, encodeState: encodeState, decodeState: decodeState
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlotlineMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
