var el = byPath(p.path);
if (!el || tagOf(el) !== 'INPUT' || inputType(el) !== 'file') return false;
clickOf(el);
return true;
