var el = byPath(p.path);
if (!el) return STALE;
if (p.scroll !== false) scrollIntoViewOf(el, { block: 'center', inline: 'center' });
return { rect: center(el), role: nodeRole(el), name: nameOf(el), check: checkState(el) };
