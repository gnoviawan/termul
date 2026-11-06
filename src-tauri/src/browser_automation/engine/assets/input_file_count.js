var el = byPath(p.path);
if (!el || tagOf(el) !== 'INPUT' || inputType(el) !== 'file') return -1;
return el.files ? el.files.length : 0;
