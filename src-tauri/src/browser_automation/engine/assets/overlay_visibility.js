// Hide or show the Iris agent overlay (agent_overlay.js) by its host tag.
// Hiding resolves after two frames, so the next capture has no overlay, and
// arms a timer that shows it again after `p.restoreMs` should the host's
// show never arrive. Showing disarms it. The timer lives on this world's
// document wrapper, out of page script's reach.
var styleProp = (function () {
  for (var proto = HTMLElement.prototype; proto; proto = Object.getPrototypeOf(proto)) {
    var d = Object.getOwnPropertyDescriptor(proto, 'style');
    if (d) return function (el) { return d.get.call(el); };
  }
  return function (el) { return el.style; };
})();
var setProp = method(CSSStyleDeclaration.prototype, 'setProperty');
var RESTORE = Symbol.for('termul.overlayRestore');
function overlays() {
  var root = docElOf(document);
  return root ? QSA[1](root, ':scope > termul-agent-overlay') : [];
}
function show(hosts, visible) {
  for (var i = 0; i < hosts.length; i++) {
    setProp(styleProp(hosts[i]), 'visibility', visible ? 'visible' : 'hidden', 'important');
  }
}
if (document[RESTORE]) {
  clearTimeout(document[RESTORE]);
  document[RESTORE] = 0;
}
var hosts = overlays();
show(hosts, p.visible);
if (!p.visible) {
  document[RESTORE] = setTimeout(function () {
    document[RESTORE] = 0;
    show(overlays(), true);
  }, p.restoreMs);
}
var found = hosts.length;
// A hidden tab paints nothing and its timers are throttled: nothing to
// wait for. Otherwise two frames, or 100ms when frames are throttled.
var hiddenOf = getter(Document.prototype, 'hidden');
if (p.visible || hiddenOf(document)) return { ok: true, found: found };
var waited = frame().then(frame);
var cap = new Promise(function (done) { setTimeout(done, 100); });
return Promise.race([waited, cap]).then(function () { return { ok: true, found: found }; });
