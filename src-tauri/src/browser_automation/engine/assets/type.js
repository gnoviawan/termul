var el = p.path ? byPath(p.path) : deepActive();
if (p.path && !el) return STALE;
if (!el || el === bodyOf(ownerDocOf(el))) return { error: 'no focused element' };
var current = editableOf(el) ? (textContentOf(el) || '') : (fieldValueOf(el) || '');
setValue(el, current + p.text);
changed(el);
return { ok: true };
