/* Plotline maths core: a safe expression parser (tokenizer + recursive descent)
   that compiles to closures, plus numeric calculus helpers and URL state.
   It never hands text to the JS engine. Free single letters become parameters. */
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
  /* letters that can never be sliders */
  var RESERVED = { x: 1, e: 1, y: 1 };

  var NAMES = Object.keys(FUNCS).concat(Object.keys(FUNCS2), Object.keys(CONSTS), Object.keys(VARS))
    .sort(function (a, b) { return b.length - a.length; });

  function ParseError(message, pos, end) {
    this.message = message;
    this.pos = pos;
    this.end = end == null ? pos + 1 : end;
  }

  function isKnown(n) { return n in FUNCS || n in FUNCS2 || n in CONSTS || n in VARS; }
  function isParamLetter(c) { return /^[a-z]$/.test(c) && !RESERVED[c]; }

  /* Split a run of letters like "xsin", "bx" or "pix" into known names and
     single-letter parameters, longest known name first. */
  function splitName(word, pos, raw) {
    if (isKnown(word)) return [word];
    var out = [], i = 0, run = 0;
    while (i < word.length) {
      var hit = null;
      for (var k = 0; k < NAMES.length; k++) {
        if (word.substr(i, NAMES[k].length) === NAMES[k]) { hit = NAMES[k]; break; }
      }
      if (hit) { out.push(hit); i += hit.length; run = 0; continue; }
      var c = word[i];
      if (c === 'y') {
        throw new ParseError('Use x as the variable. Type only the right-hand side, like x^2, without "y =".', pos + i, pos + i + 1);
      }
      if (isParamLetter(c)) {
        run++;
        if (run >= 3) throw new ParseError('Unknown name "' + raw + '". Try sin, cos, ln or sqrt, or a single letter like a for a slider.', pos, pos + word.length);
        out.push('$' + c); i++;
        continue;
      }
      throw new ParseError('Unknown name "' + raw + '".', pos, pos + word.length);
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
        if (!m) throw new ParseError('A lone "." is not a number. Write 0.5 rather than .', i, i + 1);
        tokens.push({ type: 'num', value: parseFloat(m[0]), pos: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      if (/[a-zA-Zπ]/.test(c)) {
        var w = /^[a-zA-Zπ]+/.exec(s.slice(i))[0];
        var parts = splitName(w.toLowerCase(), i, w);
        var p = i;
        parts.forEach(function (n) {
          var isParam = n[0] === '$', name = isParam ? n.slice(1) : n;
          tokens.push({ type: isParam ? 'param' : 'name', value: name, pos: p, end: p + name.length });
          p += name.length;
        });
        i += w.length;
        continue;
      }
      if (c === '*' && s[i + 1] === '*') { tokens.push({ type: 'op', value: '^', pos: i, end: i + 2 }); i += 2; continue; }
      var map = { '×': '*', '·': '*', '÷': '/', '−': '-', '[': '(', '{': '(', ']': ')', '}': ')', '√': 'sqrt' };
      if (c === '√') { tokens.push({ type: 'name', value: 'sqrt', pos: i, end: i + 1 }); i++; continue; }
      if ('+-*/^(),|'.indexOf(c) >= 0 || map[c]) { tokens.push({ type: 'op', value: map[c] || c, pos: i, end: i + 1 }); i++; continue; }
      if (c === '=') throw new ParseError('Type only the right-hand side, like x^2. There is no need for "=".', i, i + 1);
      throw new ParseError('Unexpected character "' + c + '". Remove it, or use an operator like + or *.', i, i + 1);
    }
    return tokens;
  }

  /* Grammar
     expr    := term (('+'|'-') term)*
     term    := unary (('*'|'/') unary | <implicit> power)*
     unary   := ('-'|'+') unary | power
     power   := primary ('^' unary)?          right-associative, so 2^3^2 = 2^9
     primary := num | const | x | param | func '(' args ')' | func primary | '(' expr ')' | '|' expr '|'
     Unary minus binds looser than ^, so -x^2 = -(x^2). */
  function parse(src) {
    src = String(src);
    var tokens = tokenize(src);
    if (!tokens.length) throw new ParseError('Type a function of x, for example sin(x) or x^2.', 0, 0);
    var i = 0, absDepth = 0, params = {};
    var L = src.length;
    function peek() { return tokens[i]; }
    function isOp(t, v) { return t && t.type === 'op' && t.value === v; }
    function snippet(a, b) { return src.slice(a, b).trim(); }
    function closeParen(openTok, startPos) {
      var t = peek();
      if (isOp(t, ')')) { i++; return; }
      if (!t) throw new ParseError('Missing closing bracket after "' + snippet(startPos, L) + '"', startPos, L);
      throw new ParseError('Expected ")" before "' + src.slice(t.pos, t.end) + '" to close "' + snippet(startPos, t.pos) + '"', t.pos, t.end);
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
      if (t.type === 'num' || t.type === 'name' || t.type === 'param') return true;
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
          var prev = tokens[i - 1];
          if (t.type === 'num' && prev && prev.type === 'num') {
            throw new ParseError('Two numbers in a row ("' + src.slice(prev.pos, t.end) + '"). Add an operator like * between them.', prev.pos, t.end);
          }
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
      if (!t) {
        var last = tokens[tokens.length - 1];
        throw new ParseError('The expression ends too early after "' + src.slice(last.pos, last.end) + '". Add a number or x.', last.pos, last.end);
      }
      if (t.type === 'num') { i++; return { t: 'num', v: t.value }; }
      if (t.type === 'param') { i++; params[t.value] = true; return { t: 'p', n: t.value }; }
      if (t.type === 'name') {
        i++;
        var n = t.value;
        if (n in VARS) return { t: 'x' };
        if (n in CONSTS) return { t: 'num', v: CONSTS[n] };
        if (n in FUNCS2) {
          var open = peek();
          if (!isOp(open, '(')) throw new ParseError(n + ' needs two values in brackets, like ' + n + '(x, 2).', t.pos, t.end);
          i++;
          var a = expr();
          if (!isOp(peek(), ',')) {
            var q = peek();
            throw new ParseError(n + ' needs two values separated by a comma, like ' + n + '(x, 2).', q ? q.pos : t.pos, q ? q.end : L);
          }
          i++;
          var b = expr();
          closeParen(open, t.pos);
          return { t: 'f2', f: n, a: a, b: b };
        }
        if (isOp(peek(), '(')) {
          var op = tokens[i++];
          var arg = expr();
          closeParen(op, t.pos);
          return { t: 'f1', f: n, a: arg };
        }
        if (!peek() || !startsFactor(peek())) throw new ParseError(n + ' needs an input, like ' + n + '(x).', t.pos, t.end);
        return { t: 'f1', f: n, a: power() };
      }
      if (isOp(t, '(')) {
        i++;
        if (isOp(peek(), ')')) throw new ParseError('Empty brackets. Put something inside, like (x + 1).', t.pos, peek().end);
        var inner = expr();
        closeParen(t, t.pos);
        return inner;
      }
      if (isOp(t, '|')) {
        i++;
        absDepth++;
        var body = expr();
        absDepth--;
        if (!isOp(peek(), '|')) {
          var z = peek();
          if (!z) throw new ParseError('Missing closing "|" after "' + snippet(t.pos, L) + '"', t.pos, L);
          throw new ParseError('Expected "|" before "' + src.slice(z.pos, z.end) + '"', z.pos, z.end);
        }
        i++;
        return { t: 'f1', f: 'abs', a: body };
      }
      if (isOp(t, ')')) throw new ParseError('There is an extra ")" with no matching "(".', t.pos, t.end);
      if (isOp(t, ',')) throw new ParseError('Commas only go inside min, max, pow or atan2.', t.pos, t.end);
      if (t.value === '*' || t.value === '/' || t.value === '^') {
        throw new ParseError('"' + src.slice(t.pos, t.end) + '" needs a number or x on its left.', t.pos, t.end);
      }
      throw new ParseError('Unexpected "' + src.slice(t.pos, t.end) + '".', t.pos, t.end);
    }

    var tree = expr();
    if (i < tokens.length) {
      var t = tokens[i];
      if (isOp(t, ')')) throw new ParseError('There is an extra ")" with no matching "(".', t.pos, t.end);
      if (isOp(t, ',')) throw new ParseError('Commas only go inside min, max, pow or atan2.', t.pos, t.end);
      throw new ParseError('Unexpected "' + src.slice(t.pos, t.end) + '".', t.pos, t.end);
    }
    tree.params = Object.keys(params).sort();
    return tree;
  }

  function build(node, P) {
    switch (node.t) {
      case 'num': var v = node.v; return function () { return v; };
      case 'x': return function (x) { return x; };
      case 'p': var pn = node.n; return function () { var pv = P[pn]; return pv == null ? NaN : pv; };
      case 'neg': var a0 = build(node.a, P); return function (x) { return -a0(x); };
      case 'f1': var f = FUNCS[node.f], a1 = build(node.a, P); return function (x) { return f(a1(x)); };
      case 'f2': var g = FUNCS2[node.f], a2 = build(node.a, P), b2 = build(node.b, P); return function (x) { return g(a2(x), b2(x)); };
      case 'bin':
        var l = build(node.a, P), r = build(node.b, P);
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

  /* "y = x^2" and "f(x) = x^2" are accepted: the left side is skipped. */
  var LHS = /^\s*(?:y|[a-zA-Z]\s*\(\s*x\s*\))\s*=/;

  /* compile(src, params) -> { ok, fn, tree, params, error, pos, end }.
     params is a live object read on every call, so sliders need no recompile. */
  function compile(src, P) {
    src = String(src == null ? '' : src);
    var m = LHS.exec(src), off = m ? m[0].length : 0;
    try {
      var tree = parse(src.slice(off));
      return { ok: true, fn: build(tree, P || {}), tree: tree, params: tree.params };
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: e.message, pos: e.pos + off, end: e.end + off };
      throw e;
    }
  }

  function evaluate(src, x, params) {
    var c = compile(src, params);
    if (!c.ok) throw new Error(c.error);
    return c.fn(x);
  }

  /* number input that may be an expression without x, like pi/2 */
  function evalConstant(src) {
    var c = compile(src);
    if (!c.ok) return { ok: false, error: c.error };
    if (usesX(c.tree)) return { ok: false, error: 'Use a number here, not x.' };
    if (c.params.length) return { ok: false, error: 'Use a number here. Sliders like ' + c.params[0] + ' are not allowed.' };
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
    if (!isFinite(v)) return { ok: false, error: 'This integral does not converge: the function is undefined or infinite somewhere between the bounds.' };
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

  /* where f and g cross or touch: roots of f - g where both are defined */
  function findIntersections(f, g, a, b, n) {
    var d = function (x) { var u = f(x), v = g(x); return u - v; };
    return findRoots(d, a, b, n || 1000).map(function (x) {
      return { x: x, y: cleanNum(f(x)) };
    }).filter(function (p) { return isFinite(p.y) && isFinite(g(p.x)); });
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

  /* ---------- URL hash ----------
     f=src (repeat, max 5)  col=0,1,2  hid=1  p=a,2,-10,10,0.1 (repeat)
     v=cx,cy,xw  o=flags  x0=point  ab=from,to  s=selected */
  function num(n) { return String(Number(Number(n).toPrecision(10))); }
  var FLAGS = { derivative: 'd', points: 'r', integral: 'i', trace: 't', tangent: 'n' };

  function encodeState(st) {
    var parts = [];
    st.fns.forEach(function (f) { parts.push('f=' + encodeURIComponent(f)); });
    if (st.colors && st.colors.length) parts.push('col=' + st.colors.join(','));
    if (st.hidden && st.hidden.length) parts.push('hid=' + st.hidden.join(','));
    (st.params || []).forEach(function (p) {
      parts.push('p=' + [p.n, num(p.v), num(p.min), num(p.max), num(p.step)].join(','));
    });
    parts.push('v=' + [st.view.cx, st.view.cy, st.view.xw].map(function (n) { return String(Number(n.toPrecision(8))); }).join(','));
    var flags = '';
    Object.keys(FLAGS).forEach(function (k) { if (st[k]) flags += FLAGS[k]; });
    if (flags) parts.push('o=' + flags);
    if (st.x0 != null) parts.push('x0=' + encodeURIComponent(st.x0));
    if (st.a != null) parts.push('ab=' + encodeURIComponent(st.a) + ',' + encodeURIComponent(st.b));
    if (st.focus) parts.push('s=' + st.focus);
    return '#' + parts.join('&');
  }

  function decodeState(hash) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    var st = { fns: [], colors: [], hidden: [], params: [], view: null, a: null, b: null, x0: null, focus: 0 };
    Object.keys(FLAGS).forEach(function (k) { st[k] = false; });
    h.split('&').forEach(function (kv) {
      var eq = kv.indexOf('=');
      if (eq < 0) return;
      var k = kv.slice(0, eq), v = kv.slice(eq + 1);
      try {
        if (k === 'f' && st.fns.length < 5) st.fns.push(decodeURIComponent(v));
        else if (k === 'col') st.colors = v.split(',').map(Number).filter(function (n) { return n >= 0 && n < 8; });
        else if (k === 'hid') st.hidden = v.split(',').map(Number).filter(function (n) { return n >= 0 && n < 5; });
        else if (k === 'p') {
          var q = v.split(',');
          var nums = q.slice(1).map(Number);
          if (q.length === 5 && isParamLetter(q[0]) && nums.every(isFinite) && nums[2] > nums[1] && nums[3] > 0) {
            st.params.push({ n: q[0], v: nums[0], min: nums[1], max: nums[2], step: nums[3] });
          }
        } else if (k === 'v') {
          var n = v.split(',').map(Number);
          if (n.length === 3 && n.every(isFinite) && n[2] > 0) st.view = { cx: n[0], cy: n[1], xw: n[2] };
        } else if (k === 'o') {
          Object.keys(FLAGS).forEach(function (f) { st[f] = v.indexOf(FLAGS[f]) >= 0; });
        } else if (k === 'x0') st.x0 = decodeURIComponent(v);
        else if (k === 'ab') {
          var ab = v.split(',');
          if (ab.length === 2) { st.a = decodeURIComponent(ab[0]); st.b = decodeURIComponent(ab[1]); }
        } else if (k === 's') {
          var s = parseInt(v, 10);
          if (s >= 0 && s <= 4) st.focus = s;
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
    findIntersections: findIntersections, cleanNum: cleanNum,
    fmt: fmt, encodeState: encodeState, decodeState: decodeState, isParamLetter: isParamLetter
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlotlineMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
