var el = byPath(p.path);
if (!el) return STALE;
var active = deepActive();
var editable = editableOf(el);
if (active !== el && !(editable && containsOf(el, active))) return { error: 'not_focused' };
if (editable) {
  var doc = ownerDocOf(el);
  var sel = (viewOf(doc) || window).getSelection(), range = createRangeOf(doc);
  range.selectNodeContents(el);
  if (!p.replace) range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
} else {
  var end = (fieldValueOf(el) || '').length;
  try { el.setSelectionRange(p.replace ? 0 : end, end); } catch (e) { if (p.replace) el.select(); }
}
return { ok: true };
