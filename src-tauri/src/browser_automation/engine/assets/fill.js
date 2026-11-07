var el = byPath(p.path);
if (!el) return STALE;
setValue(el, p.value);
changed(el);
return { ok: true };
