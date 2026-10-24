var el = p.path ? byPath(p.path) : deepActive();
if (p.path && !el) return STALE;
if (!el || el === el.ownerDocument.body) return { error: 'no focused element' };
var current = el.isContentEditable ? (el.textContent || '') : (el.value || '');
setValue(el, current + p.text);
changed(el);
return { ok: true };
