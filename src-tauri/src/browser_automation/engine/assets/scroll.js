if (p.path) {
  var el = byPath(p.path);
  if (!el) return STALE;
  el.scrollIntoView({ block: 'center', inline: 'center' });
} else {
  window.scrollBy(0, p.dy);
}
return { ok: true };
