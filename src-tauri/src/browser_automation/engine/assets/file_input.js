var el = byPath(p.path);
return el && tagOf(el) === 'INPUT' && inputType(el) === 'file' ? el : null;
