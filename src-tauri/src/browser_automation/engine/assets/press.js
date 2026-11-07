var active = deepActive();
var focused = active && active !== bodyOf(ownerDocOf(active)) ? active : null;
var el = p.path ? byPath(p.path) : focused;
if (p.path && !el) return STALE;
el = el || bodyOf(document);
['keydown', 'keypress', 'keyup'].forEach(function (type) {
  dispatchOf(el, new KeyboardEvent(type, { key: p.key, bubbles: true, cancelable: true }));
});
if (p.key === 'Enter' && tagOf(el) === 'BUTTON') clickOf(el);
return { ok: true };
