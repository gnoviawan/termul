var el = byPath(p.path);
if (!el) return STALE;
scrollIntoViewOf(el, { block: 'center', inline: 'center' });
return { rect: center(el), role: nodeRole(el), name: nameOf(el), check: checkState(el) };
