var el = byPath(p.path);
if (!el) return STALE;
el.scrollIntoView({ block: 'center', inline: 'center' });
var at = center(el);
['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
  var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: at.cx, clientY: at.cy, button: 0 }));
});
return { ok: true };
