var el = locate(p.path);
if (!el) return STALE;
var r = rectOf(el), s = styleOf(el), off = frameOffset(el);
return {
  x: off.x + r.left + clientLeftOf(el) + parseFloat(s.paddingLeft || '0'),
  y: off.y + r.top + clientTopOf(el) + parseFloat(s.paddingTop || '0')
};
