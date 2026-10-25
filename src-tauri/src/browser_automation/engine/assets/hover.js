var el = byPath(p.path);
if (!el) return STALE;
var at = center(el);
var init = { bubbles: true, clientX: at.cx, clientY: at.cy };
dispatchOf(el, new PointerEvent('pointerover', init));
dispatchOf(el, new MouseEvent('mouseover', init));
return { ok: true };
