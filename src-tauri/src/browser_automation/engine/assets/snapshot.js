var MAX_ITEMS = 800;
var MAX_DEPTH = 24;
var LANDMARKS = ['heading', 'navigation', 'main', 'form', 'list', 'listitem', 'img', 'table'];
var TEXT_TAGS = ['P', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'LABEL', 'HGROUP', 'CAPTION', 'FIGCAPTION'];
var SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];
var items = [];
var capped = false;
function push(item) {
  if (items.length < MAX_ITEMS) items.push(item); else capped = true;
}
function children(el) {
  if (el.shadowRoot) return Array.prototype.slice.call(el.shadowRoot.children);
  if (el.tagName === 'SLOT') {
    var assigned = el.assignedElements ? el.assignedElements() : [];
    return assigned.length ? assigned : Array.prototype.slice.call(el.children);
  }
  return Array.prototype.slice.call(el.children);
}
function walkFrame(el, depth) {
  var doc = null;
  try { doc = el.contentDocument; } catch (e) { doc = null; }
  var name = oneLine(el.getAttribute('title') || el.getAttribute('name') || '', 100);
  if (!doc || !visible(el)) {
    // Cross-origin: the host may run this helper in the frame itself.
    if (visible(el)) push({ kind: 'frame', depth: depth, name: name, path: pathOf(el) });
    return;
  }
  push({ kind: 'landmark', depth: depth, role: 'iframe', name: name });
  var root = doc.body || doc.documentElement;
  if (root) walk(root, depth + 1);
}
function walk(el, depth) {
  if (capped || depth > MAX_DEPTH) return;
  var tag = el.tagName;
  if (SKIP_TAGS.indexOf(tag) >= 0) return;
  if (tag === 'IFRAME' || tag === 'FRAME') {
    walkFrame(el, depth);
    return;
  }
  var role = roleOf(el);
  var name = nameOf(el);
  if (isInteractive(el) && visible(el)) {
    var node = { kind: 'node', depth: depth, role: nodeRole(el), name: name, path: guard + pathOf(el) };
    if (tag === 'A' && el.href) node.href = String(el.href);
    if (tag === 'INPUT') {
      node.inputType = inputType(el);
      if (node.inputType === 'checkbox' || node.inputType === 'radio') node.checked = !!el.checked;
    }
    push(node);
    return;
  }
  if (LANDMARKS.indexOf(role) >= 0) {
    push({ kind: 'landmark', depth: depth, role: role, name: name });
  } else if (TEXT_TAGS.indexOf(tag) >= 0) {
    var text = name || (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (text) push({ kind: 'text', depth: depth, text: text });
  }
  var kids = children(el);
  for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
}
// In a child frame the host reached on its own, every path pins this
// frame's document, so a ref outlives no navigation of the frame.
var guard = p.inFrame ? 'frame:' + docId(document) + '|' : '';
walk(document.body || document.documentElement, 0);
return { url: location.href, title: document.title || '', items: items, capped: capped };
