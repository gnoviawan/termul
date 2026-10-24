var el = byPath(p.path);
if (!el || el.tagName !== 'INPUT' || inputType(el) !== 'file') return false;
el.click();
return true;
