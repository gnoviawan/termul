// A form or a document that holds an element named like one of its own
// properties (<input name=nodeType>, <img name=body>) shadows that property
// in every script world. Node reads go through the prototypes' own
// accessors, captured before any page value is touched.
function getter(proto, name) {
  var d = Object.getOwnPropertyDescriptor(proto, name);
  return function (obj) { return d.get.call(obj); };
}
function method(proto, name) {
  var f = proto[name];
  return function (obj, a, b) { return f.call(obj, a, b); };
}
var nodeTypeOf = getter(Node.prototype, 'nodeType');
var parentOf = getter(Node.prototype, 'parentNode');
var ownerDocOf = getter(Node.prototype, 'ownerDocument');
var connectedOf = getter(Node.prototype, 'isConnected');
var baseOf = getter(Node.prototype, 'baseURI');
var rootOf = method(Node.prototype, 'getRootNode');
var tagOf = getter(Element.prototype, 'tagName');
var shadowOf = getter(Element.prototype, 'shadowRoot');
var nextOf = getter(Element.prototype, 'nextElementSibling');
var clientLeftOf = getter(Element.prototype, 'clientLeft');
var clientTopOf = getter(Element.prototype, 'clientTop');
var attr = method(Element.prototype, 'getAttribute');
var hasAttr = method(Element.prototype, 'hasAttribute');
var matchesOf = method(Element.prototype, 'matches');
var closestOf = method(Element.prototype, 'closest');
var rectOf = method(Element.prototype, 'getBoundingClientRect');
var scrollIntoViewOf = method(Element.prototype, 'scrollIntoView');
var docElOf = getter(Document.prototype, 'documentElement');
var bodyOf = getter(Document.prototype, 'body');
var viewOf = getter(Document.prototype, 'defaultView');
var urlOf = getter(Document.prototype, 'URL');
var pointOf = method(Document.prototype, 'elementFromPoint');
var hostOf = getter(ShadowRoot.prototype, 'host');
var formElements = getter(HTMLFormElement.prototype, 'elements');
var FIRST = {
  1: getter(Element.prototype, 'firstElementChild'),
  9: getter(Document.prototype, 'firstElementChild'),
  11: getter(DocumentFragment.prototype, 'firstElementChild')
};
var QSA = {
  1: method(Element.prototype, 'querySelectorAll'),
  9: method(Document.prototype, 'querySelectorAll'),
  11: method(DocumentFragment.prototype, 'querySelectorAll')
};
var BY_ID = { 9: method(Document.prototype, 'getElementById'), 11: method(DocumentFragment.prototype, 'getElementById') };
var FRAME_DOC = {
  IFRAME: getter(HTMLIFrameElement.prototype, 'contentDocument'),
  FRAME: getter(HTMLFrameElement.prototype, 'contentDocument'),
  OBJECT: getter(HTMLObjectElement.prototype, 'contentDocument')
};
var EDITABLE = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable');
var INNER_TEXT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
var cloneOf = method(Node.prototype, 'cloneNode');
var removeOf = method(Element.prototype, 'remove');
var textContentOf = getter(Node.prototype, 'textContent');
var inputValueOf = getter(HTMLInputElement.prototype, 'value');
var LABELS = {
  INPUT: getter(HTMLInputElement.prototype, 'labels'),
  SELECT: getter(HTMLSelectElement.prototype, 'labels'),
  TEXTAREA: getter(HTMLTextAreaElement.prototype, 'labels'),
  BUTTON: getter(HTMLButtonElement.prototype, 'labels'),
  METER: getter(HTMLMeterElement.prototype, 'labels'),
  OUTPUT: getter(HTMLOutputElement.prototype, 'labels'),
  PROGRESS: getter(HTMLProgressElement.prototype, 'labels')
};
function firstChildOf(node) {
  return FIRST[nodeTypeOf(node)](node);
}
function all(root, selector) {
  return Array.prototype.slice.call(QSA[nodeTypeOf(root)](root, selector));
}
// The document of a same-origin frame element; null for anything else.
function frameDocOf(el) {
  var read = FRAME_DOC[tagOf(el)];
  return read ? read(el) : null;
}
// The node above n, crossing out of a shadow root to its host.
function upOf(n) {
  return parentOf(n) || (nodeTypeOf(n) === 11 ? hostOf(n) : null);
}
// HTML-only properties; an SVG or MathML element has none.
function editableOf(el) {
  try { return EDITABLE.get.call(el); } catch (e) { return false; }
}
function textOf(el) {
  try { return INNER_TEXT.get.call(el) || ''; } catch (e) { return ''; }
}
var INTERACTIVE =
  'a[href],button,input,select,textarea,summary,' +
  '[role=button],[role=link],[role=textbox],[role=checkbox],[role=switch],[role=combobox],' +
  '[role=listbox],[role=menuitem],[role=tab],[role=slider],[role=searchbox],' +
  '[contenteditable=true],[contenteditable=""],[onclick],[tabindex]';
var BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
var FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton'];
var TAG_ROLE = {
  A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
  TEXTAREA: 'textbox', SUMMARY: 'button', H1: 'heading', H2: 'heading',
  H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
  HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form', IMG: 'img',
  UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table'
};
function oneLine(value, max) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}
function inputType(el) {
  return oneLine(attr(el, 'type') || 'text', 32).toLowerCase();
}
function roleOf(el) {
  var r = oneLine(attr(el, 'role') || '', 64);
  if (r) return r;
  var tag = tagOf(el);
  if (tag === 'INPUT') {
    var t = inputType(el);
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (BUTTON_TYPES.indexOf(t) >= 0) return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  return TAG_ROLE[tag] || '';
}
function checkState(el) {
  var t = tagOf(el) === 'INPUT' ? inputType(el) : '';
  if (t === 'checkbox' || t === 'radio') return { checked: !!el.checked, radio: t === 'radio' };
  var role = attr(el, 'role');
  if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox') {
    return { checked: attr(el, 'aria-checked') === 'true', radio: role === 'radio' };
  }
  return null;
}
function labelledText(el) {
  var ids = (attr(el, 'aria-labelledby') || '').split(/\s+/);
  var root = rootOf(el);
  var byId = BY_ID[nodeTypeOf(root)];
  var out = '';
  for (var i = 0; i < ids.length; i++) {
    var t = byId ? byId(root, ids[i]) : null;
    if (t) out += textOf(t) + ' ';
  }
  return out.trim();
}
// The text of a <label>, without the controls it wraps.
function labelText(label) {
  var copy = cloneOf(label, true);
  var inner = all(copy, 'input, select, textarea, script, style');
  for (var i = 0; i < inner.length; i++) removeOf(inner[i]);
  return textContentOf(copy) || '';
}
function labelsText(el) {
  var read = LABELS[tagOf(el)];
  var labels = read ? read(el) : null;
  var out = '';
  for (var i = 0; labels && i < labels.length; i++) out += labelText(labels[i]) + ' ';
  return out;
}
// A field never takes its name from what it holds: the value changes as
// the agent fills it, and the name is how a ref recognises its element.
// That also keeps a password out of every snapshot.
function contentText(el) {
  var tag = tagOf(el);
  if (tag === 'INPUT') {
    var t = inputType(el);
    if (t === 'submit') return inputValueOf(el) || 'Submit';
    if (t === 'reset') return inputValueOf(el) || 'Reset';
    return t === 'button' ? inputValueOf(el) : '';
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT' || editableOf(el)) return '';
  return FIELD_ROLES.indexOf(roleOf(el)) >= 0 ? '' : textOf(el);
}
function named(raw) {
  return oneLine(raw || '', 100);
}
function nameOf(el) {
  return named(attr(el, 'aria-labelledby') ? labelledText(el) : '') ||
    named(attr(el, 'aria-label')) || named(labelsText(el)) || named(contentText(el)) ||
    named(attr(el, 'title')) || named(attr(el, 'placeholder')) || named(attr(el, 'alt'));
}
function visible(el) {
  if (!connectedOf(el)) return false;
  var r = rectOf(el);
  if (r.width === 0 && r.height === 0) return false;
  var s = styleOf(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}
function styleOf(el) {
  var view = viewOf(ownerDocOf(el)) || window;
  return view.getComputedStyle(el);
}
// A path names an element by tag:nth-of-type steps from its root. Roots
// chain with '|': '|shadow|' enters an element's open shadow root and
// '|frame:<doc>|' a same-origin frame's document, where <doc> pins the
// document the snapshot saw. A leading 'frame:<doc>|' pins this frame's
// own document.
function docId(doc) {
  var view = doc && viewOf(doc);
  return view ? String(view.performance.timeOrigin) : '';
}
function localPath(el) {
  var segs = [];
  while (el && nodeTypeOf(el) === 1) {
    var parent = parentOf(el);
    if (!parent) return '';
    var tag = tagOf(el);
    if (nodeTypeOf(parent) === 9) {
      segs.unshift(tag.toLowerCase());
      break;
    }
    var n = 1;
    for (var c = firstChildOf(parent); c && c !== el; c = nextOf(c)) {
      if (tagOf(c) === tag) n++;
    }
    segs.unshift(tag.toLowerCase() + ':nth-of-type(' + n + ')');
    el = nodeTypeOf(parent) === 1 ? parent : null;
  }
  return segs.join('>');
}
function pathOf(el) {
  var root = rootOf(el);
  var local = localPath(el);
  var type = nodeTypeOf(root);
  if (type === 11 && hostOf(root)) return pathOf(hostOf(root)) + '|shadow|' + local;
  var view = type === 9 ? viewOf(root) : null;
  if (view && view !== window && view.frameElement) {
    return pathOf(view.frameElement) + '|frame:' + docId(root) + '|' + local;
  }
  return local;
}
function stepInto(root, local) {
  var node = root;
  var segs = local.split('>');
  for (var i = 0; i < segs.length && node; i++) {
    var m = /^([a-z0-9._-]+)(?::nth-of-type\((\d+)\))?$/.exec(segs[i]);
    if (!m) return null;
    var want = m[1], n = m[2] ? Number(m[2]) : 1, next = null;
    var isDoc = nodeTypeOf(node) === 9;
    for (var c = isDoc ? docElOf(node) : firstChildOf(node); c; c = isDoc ? null : nextOf(c)) {
      if (tagOf(c).toLowerCase() === want && --n === 0) { next = c; break; }
    }
    node = next;
  }
  return node && nodeTypeOf(node) === 1 ? node : null;
}
// Each element a snapshot reports gets a random identity, kept as a
// property of this script world's wrapper of the element, which the page
// cannot see. A snapshot path ends in '~<id>', so a path that leads to
// another element once the page has moved its siblings finds nothing
// instead of that element. A wrapper with a property of its own lives as
// long as its element; one only held as a WeakMap key does not on WebKit.
var ID_KEY = Symbol.for('termul.element-id');
function idOf(el) {
  var id = el[ID_KEY];
  if (!id) {
    id = Math.floor(Math.random() * 9007199254740991) + 1;
    el[ID_KEY] = id;
  }
  return id;
}
function locate(path) {
  var text = String(path);
  var pinned = /~(\d+)$/.exec(text);
  if (pinned) text = text.slice(0, pinned.index);
  var parts = text.split('|');
  var i = 0;
  if (parts[0].indexOf('frame:') === 0) {
    if (parts[0].slice(6) !== docId(document)) return null;
    i = 1;
  }
  var el = stepInto(document, parts[i] || '');
  for (i += 1; el && i + 1 < parts.length; i += 2) {
    var root = null;
    if (parts[i] === 'shadow') {
      root = shadowOf(el);
    } else if (parts[i].indexOf('frame:') === 0) {
      root = frameDocOf(el);
      if (root && docId(root) !== parts[i].slice(6)) root = null;
    }
    el = root ? stepInto(root, parts[i + 1]) : null;
  }
  return el && (!pinned || el[ID_KEY] === Number(pinned[1])) ? el : null;
}
function isInteractive(el) {
  try { return matchesOf(el, INTERACTIVE); } catch (e) { return false; }
}
function nodeRole(el) {
  return roleOf(el) || tagOf(el).toLowerCase();
}
function byPath(path) {
  var el = locate(path);
  return el && visible(el) ? el : null;
}
// The offset of el's frame viewport in this frame's viewport, through
// every same-origin frame in between.
function frameOffset(el) {
  var x = 0, y = 0;
  for (var view = viewOf(ownerDocOf(el)); view && view !== window; view = view.parent) {
    var owner = view.frameElement;
    if (!owner) break;
    var r = rectOf(owner), s = styleOf(owner);
    x += r.left + clientLeftOf(owner) + parseFloat(s.paddingLeft || '0');
    y += r.top + clientTopOf(owner) + parseFloat(s.paddingTop || '0');
  }
  return { x: x, y: y };
}
// A background tab may never paint, so a frame also ends on a timer.
function frame() {
  return new Promise(function (done) {
    var fired = false;
    function go() { if (!fired) { fired = true; done(); } }
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}
function center(el) {
  var rc = rectOf(el);
  var off = frameOffset(el);
  return { cx: off.x + rc.left + rc.width / 2, cy: off.y + rc.top + rc.height / 2, w: rc.width, h: rc.height };
}
var ACTIVE = getter(Document.prototype, 'activeElement');
var SHADOW_ACTIVE = getter(ShadowRoot.prototype, 'activeElement');
function deepActive() {
  var a = ACTIVE(document);
  for (;;) {
    var inner = null;
    var shadow = a && shadowOf(a);
    if (shadow && SHADOW_ACTIVE(shadow)) inner = SHADOW_ACTIVE(shadow);
    else if (a && tagOf(a) === 'IFRAME') {
      var doc = frameDocOf(a);
      inner = doc && ACTIVE(doc);
      if (inner && inner === bodyOf(ownerDocOf(inner))) inner = null;
    }
    if (!inner || inner === a) return a;
    a = inner;
  }
}
function setValue(el, value) {
  if (editableOf(el)) {
    el.textContent = value;
    return;
  }
  var tag = tagOf(el);
  var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : tag === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
}
function changed(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
var STALE = { error: 'stale_ref' };
