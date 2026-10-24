var el = byPath(p.path);
return el && el.tagName === 'INPUT' && inputType(el) === 'file' ? el : null;
