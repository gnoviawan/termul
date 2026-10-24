var el = locate(p.path);
if (!el) return STALE;
var r = el.getBoundingClientRect(), s = styleOf(el), off = frameOffset(el);
return {
  x: off.x + r.left + el.clientLeft + parseFloat(s.paddingLeft || '0'),
  y: off.y + r.top + el.clientTop + parseFloat(s.paddingTop || '0')
};
