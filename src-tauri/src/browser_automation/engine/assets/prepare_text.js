var el = byPath(p.path);
if (!el) return STALE;
var active = deepActive();
if (active !== el && !(el.isContentEditable && el.contains(active))) return { error: 'not_focused' };
if (el.isContentEditable) {
  var doc = el.ownerDocument;
  var sel = (doc.defaultView || window).getSelection(), range = doc.createRange();
  range.selectNodeContents(el);
  if (!p.replace) range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
} else {
  var end = (el.value || '').length;
  try { el.setSelectionRange(p.replace ? 0 : end, end); } catch (e) { if (p.replace) el.select(); }
}
return { ok: true };
