var el = byPath(p.path);
if (!el) return STALE;
if (el.tagName !== 'SELECT') return { error: 'not_a_select' };
var want = String(p.value);
var options = Array.prototype.slice.call(el.options);
var pick = options.filter(function (o) { return o.value === want; })[0] ||
  options.filter(function (o) { return String(o.label || o.text).trim() === want.trim(); })[0];
if (!pick) return { error: 'no_such_option' };
if (pick.disabled || el.disabled) return { error: 'option_disabled' };
setValue(el, pick.value);
changed(el);
return { ok: true };
