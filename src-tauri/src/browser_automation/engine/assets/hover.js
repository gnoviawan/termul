var el = byPath(p.path);
if (!el) return STALE;
var at = center(el);
var init = { bubbles: true, clientX: at.cx, clientY: at.cy };
el.dispatchEvent(new PointerEvent('pointerover', init));
el.dispatchEvent(new MouseEvent('mouseover', init));
return { ok: true };
