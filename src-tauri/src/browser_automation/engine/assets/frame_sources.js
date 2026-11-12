// Where each frame, object and embed of the document points, as absolute
// URLs, open shadow roots and same-origin frames included: a link hop one
// of them made keeps exact file grants.
var READ = {};
function reader(ctor, name) {
  return typeof ctor === 'function' ? getter(ctor.prototype, name) : null;
}
READ.IFRAME = reader(window.HTMLIFrameElement, 'src');
READ.FRAME = reader(window.HTMLFrameElement, 'src');
READ.EMBED = reader(window.HTMLEmbedElement, 'src');
READ.OBJECT = reader(window.HTMLObjectElement, 'data');
var out = [];
var found = deepAll(document, 'iframe, frame, embed, object', []);
for (var i = 0; i < found.length; i++) {
  var read = READ[tagOf(found[i])];
  var source = read ? read(found[i]) : '';
  if (source) out.push(String(source));
}
return out;
