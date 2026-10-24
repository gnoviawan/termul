var INTERACTIVE =
  'a[href],button,input,select,textarea,summary,' +
  '[role=button],[role=link],[role=textbox],[role=checkbox],[role=switch],[role=combobox],' +
  '[role=listbox],[role=menuitem],[role=tab],[role=slider],[role=searchbox],' +
  '[contenteditable=true],[contenteditable=""],[onclick],[tabindex]';
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
  return oneLine(el.getAttribute('type') || 'text', 32).toLowerCase();
}
function roleOf(el) {
  var r = oneLine(el.getAttribute('role') || '', 64);
  if (r) return r;
  if (el.tagName === 'INPUT') {
    var t = inputType(el);
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button') return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  return TAG_ROLE[el.tagName] || '';
}
function checkState(el) {
  var t = el.tagName === 'INPUT' ? inputType(el) : '';
  if (t === 'checkbox' || t === 'radio') return { checked: !!el.checked, radio: t === 'radio' };
  var role = el.getAttribute('role');
  if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox') {
    return { checked: el.getAttribute('aria-checked') === 'true', radio: role === 'radio' };
  }
  return null;
}
function labelledText(el) {
  var ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
  var root = el.getRootNode();
  var out = '';
  for (var i = 0; i < ids.length; i++) {
    var t = root.getElementById ? root.getElementById(ids[i]) : null;
    if (t) out += (t.innerText || '') + ' ';
  }
  return out.trim();
}
function nameOf(el) {
  // A password value never leaves the page: snapshots reach the agent's
  // model provider, and autofill would put credentials in the transcript.
  var secret = el.tagName === 'INPUT' && inputType(el) === 'password';
  var raw = el.getAttribute('aria-label') ||
    (el.getAttribute('aria-labelledby') ? labelledText(el) : '') ||
    el.getAttribute('title') || el.getAttribute('placeholder') ||
    el.getAttribute('alt') || el.innerText ||
    (secret ? (el.value ? '[redacted]' : '') : el.value) || '';
  return oneLine(raw, 100);
}
function visible(el) {
  if (!el.isConnected) return false;
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  var s = styleOf(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}
function styleOf(el) {
  var view = el.ownerDocument.defaultView || window;
  return view.getComputedStyle(el);
}
// A path names an element by tag:nth-of-type steps from its root. Roots
// chain with '|': '|shadow|' enters an element's open shadow root and
// '|frame:<doc>|' a same-origin frame's document, where <doc> pins the
// document the snapshot saw. A leading 'frame:<doc>|' pins this frame's
// own document.
function docId(doc) {
  var view = doc && doc.defaultView;
  return view ? String(view.performance.timeOrigin) : '';
}
function localPath(el) {
  var segs = [];
  while (el && el.nodeType === 1) {
    var parent = el.parentNode;
    if (!parent) return '';
    var tag = el.tagName;
    if (parent.nodeType === 9) {
      segs.unshift(tag.toLowerCase());
      break;
    }
    var n = 1;
    for (var c = parent.firstElementChild; c && c !== el; c = c.nextElementSibling) {
      if (c.tagName === tag) n++;
    }
    segs.unshift(tag.toLowerCase() + ':nth-of-type(' + n + ')');
    el = parent.nodeType === 1 ? parent : null;
  }
  return segs.join('>');
}
function pathOf(el) {
  var root = el.getRootNode();
  var local = localPath(el);
  if (root.nodeType === 11 && root.host) return pathOf(root.host) + '|shadow|' + local;
  var view = root.nodeType === 9 ? root.defaultView : null;
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
    for (var c = node.nodeType === 9 ? node.documentElement : node.firstElementChild;
      c; c = node.nodeType === 9 ? null : c.nextElementSibling) {
      if (c.tagName.toLowerCase() === want && --n === 0) { next = c; break; }
    }
    node = next;
  }
  return node && node.nodeType === 1 ? node : null;
}
function locate(path) {
  var parts = String(path).split('|');
  var i = 0;
  if (parts[0].indexOf('frame:') === 0) {
    if (parts[0].slice(6) !== docId(document)) return null;
    i = 1;
  }
  var el = stepInto(document, parts[i] || '');
  for (i += 1; el && i + 1 < parts.length; i += 2) {
    var root = null;
    if (parts[i] === 'shadow') {
      root = el.shadowRoot;
    } else if (parts[i].indexOf('frame:') === 0) {
      try { root = el.contentDocument; } catch (e) { root = null; }
      if (root && docId(root) !== parts[i].slice(6)) root = null;
    }
    el = root ? stepInto(root, parts[i + 1]) : null;
  }
  return el;
}
function isInteractive(el) {
  try { return el.matches(INTERACTIVE); } catch (e) { return false; }
}
function nodeRole(el) {
  return roleOf(el) || el.tagName.toLowerCase();
}
function byPath(path) {
  var el = locate(path);
  return el && visible(el) ? el : null;
}
// The offset of el's frame viewport in this frame's viewport, through
// every same-origin frame in between.
function frameOffset(el) {
  var x = 0, y = 0;
  for (var view = el.ownerDocument.defaultView; view && view !== window; view = view.parent) {
    var owner = view.frameElement;
    if (!owner) break;
    var r = owner.getBoundingClientRect(), s = styleOf(owner);
    x += r.left + owner.clientLeft + parseFloat(s.paddingLeft || '0');
    y += r.top + owner.clientTop + parseFloat(s.paddingTop || '0');
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
  var rc = el.getBoundingClientRect();
  var off = frameOffset(el);
  return { cx: off.x + rc.left + rc.width / 2, cy: off.y + rc.top + rc.height / 2, w: rc.width, h: rc.height };
}
// Read through the prototype: an element named activeElement shadows the
// document's own property.
var ACTIVE = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
function activeOf(doc) {
  return ACTIVE ? ACTIVE.get.call(doc) : doc.activeElement;
}
function deepActive() {
  var a = activeOf(document);
  for (;;) {
    var inner = null;
    if (a && a.shadowRoot && a.shadowRoot.activeElement) inner = a.shadowRoot.activeElement;
    else if (a && a.tagName === 'IFRAME') {
      try { inner = a.contentDocument && activeOf(a.contentDocument); } catch (e) { inner = null; }
      if (inner && inner === inner.ownerDocument.body) inner = null;
    }
    if (!inner || inner === a) return a;
    a = inner;
  }
}
function setValue(el, value) {
  if (el.isContentEditable) {
    el.textContent = value;
    return;
  }
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
}
function changed(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
var STALE = { error: 'stale_ref' };
