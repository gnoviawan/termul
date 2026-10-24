var from = byPath(p.path);
var to = byPath(p.to);
if (!from || !to) return STALE;
var STEPS = 6;
function mid(el) {
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function fire(type, target, at, buttons) {
  var pointer = type.indexOf('pointer') === 0;
  var init = {
    bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y,
    button: pointer && type === 'pointermove' ? -1 : 0, buttons: buttons
  };
  if (pointer) {
    init.pointerId = 1;
    init.pointerType = 'mouse';
    init.isPrimary = true;
  }
  target.dispatchEvent(pointer ? new PointerEvent(type, init) : new MouseEvent(type, init));
}
var a = mid(from);
var b = mid(to);
var step = 0;
function advance() {
  if (step >= STEPS) return Promise.resolve();
  step += 1;
  var t = step / STEPS;
  var at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  var target = from.ownerDocument.elementFromPoint(at.x, at.y) || from;
  fire('pointermove', target, at, 1);
  fire('mousemove', target, at, 1);
  return frame().then(advance);
}
fire('pointerdown', from, a, 1);
fire('mousedown', from, a, 1);
return advance().then(function () {
  fire('pointerup', to, b, 0);
  fire('mouseup', to, b, 0);
  return { ok: true };
});
