var active = deepActive();
var focused = active && active !== active.ownerDocument.body ? active : null;
var el = p.path ? byPath(p.path) : focused;
if (p.path && !el) return STALE;
el = el || document.body;
['keydown', 'keypress', 'keyup'].forEach(function (type) {
  el.dispatchEvent(new KeyboardEvent(type, { key: p.key, bubbles: true, cancelable: true }));
});
if (p.key === 'Enter' && el.tagName === 'BUTTON') el.click();
return { ok: true };
