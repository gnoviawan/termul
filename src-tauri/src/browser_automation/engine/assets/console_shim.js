(function () {
  var MAX = 200, TEXT = 2048;
  var buf = [];
  function text(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i], t;
      try {
        t = typeof a === 'string' ? a
          : a && typeof a === 'object' && typeof a.stack === 'string' ? a.stack
          : a && typeof a === 'object' ? JSON.stringify(a) : String(a);
      } catch (e) {
        t = Object.prototype.toString.call(a);
      }
      out.push(t === undefined ? String(a) : t);
    }
    return out.join(' ').slice(0, TEXT);
  }
  function record(level, args, source) {
    if (buf.length >= MAX) buf.shift();
    buf.push({ level: level, text: text(args), source: source || '' });
  }
  ['debug', 'log', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function () {
      try { record(level, arguments); } catch (e) {}
      return original.apply(this, arguments);
    };
  });
  addEventListener('error', function (e) {
    if (e && typeof e.message === 'string' && e.message) record('error', [e.message], e.filename);
  }, true);
  addEventListener('unhandledrejection', function (e) {
    record('error', ['Unhandled promise rejection:', e && e.reason]);
  });
  addEventListener('termul-console-pull', function () {
    var out = buf;
    buf = [];
    dispatchEvent(new CustomEvent('termul-console-entries', { detail: JSON.stringify(out) }));
  });
})();
