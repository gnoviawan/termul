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
  var shadow = shadowOf(el);
  if (shadow) return elementsIn(shadow);
  if (tagOf(el) === 'SLOT') {
    var assigned = assignedOf ? assignedOf(el) : [];
    return assigned.length ? assigned : elementsIn(el);
  }
  return elementsIn(el);
}
function walkFrame(el, depth) {
  var doc = frameDocOf(el);
  var name = oneLine(attr(el, 'title') || attr(el, 'name') || '', 100);
  if (!doc || !visible(el)) {
    // Cross-origin: the host may run this helper in the frame itself.
    if (visible(el)) push({ kind: 'frame', depth: depth, name: name, path: pathOf(el) });
    return;
  }
  push({ kind: 'landmark', depth: depth, role: 'iframe', name: name });
  var root = bodyOf(doc) || docElOf(doc);
  if (root) walk(root, depth + 1);
}
function walk(el, depth) {
  if (capped || depth > MAX_DEPTH) return;
  var tag = tagOf(el);
  if (SKIP_TAGS.indexOf(tag) >= 0) return;
  if (tag === 'IFRAME' || tag === 'FRAME') {
    walkFrame(el, depth);
    return;
  }
  var role = roleOf(el);
  var name = nameOf(el);
  if (isInteractive(el) && visible(el)) {
    var node = { kind: 'node', depth: depth, role: nodeRole(el), name: name, path: guard + pathOf(el) + '~' + idOf(el) };
    if (tag === 'A' && hrefOf(el)) node.href = String(hrefOf(el));
    if (tag === 'INPUT') {
      node.inputType = inputType(el);
      if (node.inputType === 'checkbox' || node.inputType === 'radio') node.checked = !!checkedOf(el);
    }
    push(node);
    return;
  }
  if (LANDMARKS.indexOf(role) >= 0) {
    push({ kind: 'landmark', depth: depth, role: role, name: name });
  } else if (TEXT_TAGS.indexOf(tag) >= 0) {
    var text = name || textOf(el).replace(/\s+/g, ' ').trim().slice(0, 140);
    if (text) push({ kind: 'text', depth: depth, text: text });
  }
  var kids = children(el);
  for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
}
// In a child frame the host reached on its own, every path pins this
// frame's document, so a ref outlives no navigation of the frame.
var guard = p.inFrame ? 'frame:' + docId(document) + '|' : '';
walk(bodyOf(document) || docElOf(document), 0);
return { url: location.href, title: titleOf(document) || '', items: items, capped: capped };
