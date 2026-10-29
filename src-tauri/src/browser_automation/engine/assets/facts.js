var el = locate(p.path);
if (!el || !connectedOf(el)) return { state: 'detached' };
var FOCUSES_ON_CLICK = 'textarea, select, iframe, embed, object, input:not([type=button i], ' +
  '[type=submit i], [type=reset i], [type=checkbox i], [type=radio i], [type=image i], ' +
  '[type=file i], [type=range i], [type=color i])';
var CHECK_VISIBILITY = Element.prototype.checkVisibility;
var shadowPointOf = method(ShadowRoot.prototype, 'elementFromPoint');
var view = viewOf(ownerDocOf(el)) || window;
function local() { var r = rectOf(el); return [r.left, r.top, r.width, r.height]; }
// The box in this frame's viewport, through any same-origin frames.
function box() { var l = local(), off = frameOffset(el); return [off.x + l[0], off.y + l[1], l[2], l[3]]; }
function same(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }
// The action lands on the centre, so that is what must be in view.
function inside(b, w, h) { var x = b[0] + b[2] / 2, y = b[1] + b[3] / 2; return x >= 0 && y >= 0 && x < w && y < h; }
function shown() { var l = local(); return inside(l, view.innerWidth, view.innerHeight) && inside(box(), innerWidth, innerHeight); }
// The element under (x, y) of this frame's viewport, through open shadow
// roots and into same-origin frames.
function deepHit(x, y) {
  var doc = document;
  for (;;) {
    var hit = pointOf(doc, x, y);
    for (var shadow = hit && shadowOf(hit); shadow; shadow = hit && shadowOf(hit)) {
      var inner = shadowPointOf(shadow, x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    var tag = hit && tagOf(hit);
    if (tag !== 'IFRAME' && tag !== 'FRAME') return hit;
    var sub = frameDocOf(hit);
    if (!sub) return hit;
    var r = rectOf(hit), s = styleOf(hit);
    x -= r.left + clientLeftOf(hit) + parseFloat(s.paddingLeft || '0');
    y -= r.top + clientTopOf(hit) + parseFloat(s.paddingTop || '0');
    doc = sub;
  }
}
var b0 = box();
var sized = b0[2] > 0 && b0[3] > 0;
var inView = sized && shown();
if (sized && !inView) scrollIntoViewOf(el, { block: 'center', inline: 'center' });
return frame().then(function () {
  var b1 = box();
  return frame().then(function () {
    var b2 = box();
    var s = styleOf(el);
    var visibleStyle = typeof CHECK_VISIBILITY === 'function'
      ? CHECK_VISIBILITY.call(el, { visibilityProperty: true, opacityProperty: false })
      : (s.visibility !== 'hidden' && s.display !== 'none');
    var x = b2[0] + b2[2] / 2, y = b2[1] + b2[3] / 2;
    var hit = deepHit(x, y);
    var onTarget = false;
    for (var n = hit; n; n = upOf(n)) { if (n === el) { onTarget = true; break; } }
    var disabled = matchesOf(el, ':disabled') || attr(el, 'aria-disabled') === 'true' ||
      !!closestOf(el, '[inert]');
    var kind = matchesOf(el, ':read-write') ? 'text' : (tagOf(el) === 'SELECT' ? 'select' : 'other');
    var focusOnClick = false;
    for (var f = hit || el; f && !focusOnClick; f = upOf(f)) {
      focusOnClick = nodeTypeOf(f) === 1 && (editableOf(f) || hasAttr(f, 'tabindex') ||
        matchesOf(f, FOCUSES_ON_CLICK) || (tagOf(f) === 'LABEL' && !!f.control));
    }
    return {
      state: 'present', role: nodeRole(el), name: nameOf(el), x: x, y: y,
      visible: b2[2] > 0 && b2[3] > 0 && visibleStyle,
      stable: inView && same(b0, b1) && same(b1, b2),
      hit: onTarget, enabled: !disabled, kind: kind, focusOnClick: focusOnClick
    };
  });
});
