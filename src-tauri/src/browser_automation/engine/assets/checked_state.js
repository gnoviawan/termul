var el = byPath(p.path);
if (!el) return STALE;
return checkState(el) || { error: 'not_checkable' };
