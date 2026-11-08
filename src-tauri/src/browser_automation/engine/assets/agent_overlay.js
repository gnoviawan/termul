// The "Iris" agent-control overlay: a dithered pixel grid in the brand
// blue -> purple -> pink stops over the whole viewport, clearing to a circle
// that eases toward the user's pointer. Main world, main frame, agent tabs
// only, re-run on every new document. It is one host element on <html> with
// a closed shadow root and a pointer-transparent canvas: nothing in it is
// interactive, and nothing is built from markup or style text (page CSP and
// Trusted Types refuse those). Every browser API it uses is captured here,
// before page script can replace it. The host hides it around agent
// screenshots (the `overlay_visibility` helper) by the host's tag name.
(function () {
  'use strict';
  if (window.top !== window) return;
  // An engine missing an API this needs shows no overlay, and says nothing
  // in the page's console.
  try { init(); } catch (e) {}
  function init() {
  var doc = document;
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var TAG = 'termul-agent-overlay';

  // The property's own descriptor on `proto` or the nearest prototype above.
  function own(proto, name) {
    for (var p = proto; p; p = Object.getPrototypeOf(p)) {
      var d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d;
    }
    throw new Error(name);
  }
  var raf = window.requestAnimationFrame.bind(window);
  var nowOf = performance.now.bind(performance);
  var createEl = Document.prototype.createElement;
  var attach = Element.prototype.attachShadow;
  var append = Node.prototype.appendChild;
  var listen = EventTarget.prototype.addEventListener;
  var unlisten = EventTarget.prototype.removeEventListener;
  var connectedOf = own(Node.prototype, 'isConnected').get;
  var parentOf = own(Node.prototype, 'parentNode').get;
  var docElOf = own(Document.prototype, 'documentElement').get;
  var hiddenOf = own(Document.prototype, 'hidden').get;
  var nsOf = own(Element.prototype, 'namespaceURI').get;
  var styleOf = own(HTMLElement.prototype, 'style').get;
  var setProp = CSSStyleDeclaration.prototype.setProperty;
  var getContext = HTMLCanvasElement.prototype.getContext;
  var setWidth = own(HTMLCanvasElement.prototype, 'width').set;
  var setHeight = own(HTMLCanvasElement.prototype, 'height').set;
  var C2D = CanvasRenderingContext2D.prototype;
  var fillRect = C2D.fillRect;
  var clearRect = C2D.clearRect;
  var setTransform = C2D.setTransform;
  var setFill = own(C2D, 'fillStyle').set;
  var setAlpha = own(C2D, 'globalAlpha').set;
  var media = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  var sin = Math.sin, cos = Math.cos, atan2 = Math.atan2, sqrt = Math.sqrt, pow = Math.pow;
  var min = Math.min, max = Math.max, floor = Math.floor, ceil = Math.ceil, round = Math.round;
  var exp = Math.exp, PI = Math.PI;

  var root = docElOf.call(doc);
  if (root && nsOf.call(root) !== HTML_NS) return;

  var CELL = 8, GAP = 2, STEP = CELL + GAP;
  // Cells drawn per frame at most: a 4K or high-density viewport grows its
  // cells instead of the per-frame work.
  var MAX_CELLS = 12000;
  var FRAME_MS = 1000 / 30;
  var MAX_ALPHA = 0.5;
  // 4x4 Bayer ordered dither: crisp on/off pixels instead of soft alpha.
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(function (v) { return (v + 0.5) / 16; });
  // Brand stops (status-bar blue, purple, pink), brighter for legibility
  // on pages, as oklch [L, C, h].
  var STOPS = [[0.62, 0.19, 259.7], [0.6, 0.25, 301.8], [0.64, 0.2, 353.9]];
  var HUES = 96;

  function srgb(x) {
    var v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055;
    return round(max(0, min(1, v)) * 255);
  }
  function oklchToRgb(L, C, h) {
    var a = C * cos(h * PI / 180), b = C * sin(h * PI / 180);
    var l = pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return 'rgb(' + srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) + ',' +
      srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) + ',' +
      srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) + ')';
  }
  // One colour string per hue step, built once: cells pick from the cache
  // and carry their strength in globalAlpha.
  var PALETTE = [];
  for (var k = 0; k < HUES; k++) {
    var p = k / HUES * 3, i0 = floor(p), f = p - i0;
    var A = STOPS[i0 % 3], B = STOPS[(i0 + 1) % 3];
    var h = A[2] + (B[2] - A[2]) * f;
    if (Math.abs(B[2] - A[2]) > 180) h = A[2];
    PALETTE.push(oklchToRgb(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, h));
  }

  function css(el, props) {
    var style = styleOf.call(el);
    for (var key in props) setProp.call(style, key, props[key], 'important');
  }

  var host = createEl.call(doc, TAG);
  css(host, {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', width: '100%', height: '100%',
    display: 'block', margin: '0', padding: '0', border: '0', background: 'transparent',
    'pointer-events': 'none', 'z-index': '2147483647', visibility: 'visible', opacity: '1',
    transform: 'none', filter: 'none', contain: 'strict'
  });
  var shadow = attach.call(host, { mode: 'closed' });
  var canvas = createEl.call(doc, 'canvas');
  css(canvas, {
    display: 'block', width: '100%', height: '100%', margin: '0', padding: '0', border: '0',
    'pointer-events': 'none', 'image-rendering': 'pixelated'
  });
  append.call(shadow, canvas);
  var ctx = getContext.call(canvas, '2d');
  if (!ctx) return;

  var motionQuery = media ? media('(prefers-reduced-motion: reduce)') : null;
  var reduce = !!(motionQuery && motionQuery.matches);
  var W = 0, H = 0, D = 0;
  var focus = { x: 0.5, y: 0.5 }, target = { x: 0.5, y: 0.5 };
  // Iris close: the clear circle starts wider than the viewport and closes.
  var presence = reduce ? 1 : 0;
  var last = 0, started = 0, running = false;

  function place() {
    var el = docElOf.call(doc);
    if (!el || nsOf.call(el) !== HTML_NS) return false;
    if (!connectedOf.call(host) || parentOf.call(host) !== el) append.call(el, host);
    return true;
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = max(1, window.innerWidth | 0), hh = max(1, window.innerHeight | 0);
    if (w === W && hh === H && dpr === D) return;
    W = w; H = hh; D = dpr;
    setWidth.call(canvas, round(W * dpr));
    setHeight.call(canvas, round(H * dpr));
    setTransform.call(ctx, dpr, 0, 0, dpr, 0, 0);
  }

  function smooth(a, b, x) {
    var t = min(1, max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function draw(t) {
    clearRect.call(ctx, 0, 0, W, H);
    var cx = focus.x * W, cy = focus.y * H;
    var minS = min(W, H);
    var R = minS * 0.3 + (1 - presence) * sqrt(W * W + H * H);
    var fall = minS * 0.42;
    var spin = t * 0.04;
    var step = STEP, cell = CELL;
    var cells = ceil(W / STEP) * ceil(H / STEP);
    if (cells > MAX_CELLS) {
      step = ceil(STEP * sqrt(cells / MAX_CELLS));
      cell = step - GAP;
    }
    var cols = ceil(W / step), rows = ceil(H / step);
    for (var j = 0; j < rows; j++) {
      var y = j * step + step / 2, dy = y - cy;
      for (var i = 0; i < cols; i++) {
        var x = i * step + step / 2, dx = x - cx;
        var d = sqrt(dx * dx + dy * dy);
        if (d <= R) continue;
        // 0 inside the circle, 1 at the edges, plus an outward ripple.
        var v = smooth(R, R + fall, d) + 0.18 * sin(d * 0.035 - t * 2.2) * smooth(R, R + 40, d);
        if (v <= BAYER[(j & 3) * 4 + (i & 3)]) continue;
        var sparkle = 0.75 + 0.25 * sin(i * 12.9898 + j * 78.233 + t * 3);
        var ang = atan2(dy, dx) / (2 * PI) + spin;
        ang -= floor(ang);
        setAlpha.call(ctx, MAX_ALPHA * min(1, v) * sparkle);
        setFill.call(ctx, PALETTE[floor(ang * HUES) % HUES]);
        fillRect.call(ctx, i * step, j * step, cell, cell);
      }
    }
    setAlpha.call(ctx, 1);
  }

  function still() {
    if (!place()) return;
    resize();
    draw(0);
  }

  function tick(now) {
    running = false;
    if (reduce) return;
    if (hiddenOf.call(doc)) return;
    schedule();
    if (now - last < FRAME_MS) return;
    var dt = last ? min(0.25, (now - last) / 1000) : 0;
    last = now;
    if (!place()) return;
    resize();
    presence += (1 - presence) * (1 - exp(-dt / 0.35));
    var ease = 1 - exp(-dt / 0.14);
    focus.x += (target.x - focus.x) * ease;
    focus.y += (target.y - focus.y) * ease;
    draw((now - started) / 1000);
  }

  function schedule() {
    if (running || reduce) return;
    running = true;
    raf(tick);
  }

  function start() {
    if (reduce) {
      still();
      return;
    }
    if (!started) started = nowOf();
    schedule();
  }

  var opts = { capture: true, passive: true };
  function onMove(e) {
    if (!W || !H) return;
    target = { x: min(1, max(0, e.clientX / W)), y: min(1, max(0, e.clientY / H)) };
  }
  // Leaving the page drifts the circle back to the centre.
  function onOut(e) {
    if (!e.relatedTarget) target = { x: 0.5, y: 0.5 };
  }
  function onBlur() { target = { x: 0.5, y: 0.5 }; }
  function onVisible() {
    if (!hiddenOf.call(doc)) { last = 0; schedule(); }
  }
  // Pointer-follow and the animation loop only while motion is welcome.
  function follow(on) {
    var change = on ? listen : unlisten;
    change.call(window, 'pointermove', onMove, opts);
    change.call(window, 'pointerout', onOut, opts);
    change.call(window, 'blur', onBlur, opts);
    change.call(doc, 'visibilitychange', onVisible, opts);
  }
  if (!reduce) follow(true);
  listen.call(window, 'resize', function () { if (reduce) still(); }, opts);
  // The user can change the motion setting while the page is open.
  if (motionQuery && typeof motionQuery.addEventListener === 'function') {
    listen.call(motionQuery, 'change', function (e) {
      var wanted = !!e.matches;
      if (wanted === reduce) return;
      reduce = wanted;
      follow(!reduce);
      if (reduce) {
        presence = 1;
        focus = { x: 0.5, y: 0.5 };
        target = { x: 0.5, y: 0.5 };
        still();
      } else {
        last = 0;
        start();
      }
    });
  }

  if (place()) {
    start();
  } else {
    // Some engines run document-start scripts before <html> exists.
    listen.call(doc, 'readystatechange', function () { if (place()) start(); }, opts);
    listen.call(doc, 'DOMContentLoaded', function () { if (place()) start(); }, opts);
  }
  }
})();
