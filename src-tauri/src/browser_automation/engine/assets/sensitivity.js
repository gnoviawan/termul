// A form or document element named like one of their own properties
// (<input name=elements>, <img name=URL>) shadows that property in every
// script world. Reads on them go through the prototypes' own accessors.
function getter(proto, name) {
  var d = Object.getOwnPropertyDescriptor(proto, name);
  return function (obj) { return d.get.call(obj); };
}
var formElements = getter(HTMLFormElement.prototype, 'elements');
var tagOf = getter(Element.prototype, 'tagName');
var shadowOf = getter(Element.prototype, 'shadowRoot');
var ownerDocOf = getter(Node.prototype, 'ownerDocument');
var baseOf = getter(Node.prototype, 'baseURI');
var urlOf = getter(Document.prototype, 'URL');
var bodyOf = getter(Document.prototype, 'body');
var iframeDocOf = getter(HTMLIFrameElement.prototype, 'contentDocument');
var frameDocOf = getter(HTMLFrameElement.prototype, 'contentDocument');
var attr = Element.prototype.getAttribute;
var closest = Element.prototype.closest;
var QSA = { 1: Element.prototype.querySelectorAll, 9: Document.prototype.querySelectorAll, 11: DocumentFragment.prototype.querySelectorAll };
function all(root, selector) {
  return Array.prototype.slice.call(QSA[root.nodeType].call(root, selector));
}
var target = p.path ? locate(p.path) : deepActive();
if (p.path && !target) return STALE;
var facts = {
  frameOrigin: location.origin,
  targetInForm: false,
  regionHasPassword: false,
  regionHasPayment: false,
  isSubmitter: false,
  isTextEntry: false,
  isFileInput: false,
  formAction: null,
  linkTarget: null
};
if (!target) return facts;
var doc = ownerDocOf(target);
if (target === bodyOf(doc)) return facts;
var tag = tagOf(target);
// Keys without a ref reach focus inside a frame these helpers cannot read;
// what is focused there is unknown, so it counts as a credential form.
var opaque = false;
if (!p.path && (tag === 'IFRAME' || tag === 'FRAME')) {
  try { opaque = !target.contentDocument; } catch (e) { opaque = true; }
}
if (opaque) {
  facts.targetInForm = facts.regionHasPassword = facts.regionHasPayment = facts.isSubmitter = true;
  return facts;
}
function absolute(href) {
  try { return new URL(href, baseOf(doc)).href; } catch (e) { return null; }
}
function tokens(el) {
  return (attr.call(el, 'autocomplete') || '').toLowerCase().split(/\s+/);
}
var CARD_NAME = /card.?num|cc.?num|cvc|cvv|csc|security.?code|expir/i;
var NOT_TEXT = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range', 'hidden'];
function isPassword(el) {
  if (tagOf(el) === 'INPUT' && inputType(el) === 'password') return true;
  return tokens(el).some(function (t) {
    return t === 'current-password' || t === 'new-password' || t === 'one-time-code';
  });
}
function isPayment(el) {
  if (tokens(el).some(function (t) { return t.indexOf('cc-') === 0; })) return true;
  return CARD_NAME.test((attr.call(el, 'name') || '') + ' ' + (attr.call(el, 'id') || ''));
}
var FIELDS = 'input,select,textarea,[autocomplete]';
// Fields under root, open shadow roots and same-origin frames included.
function deepFields(root, out) {
  Array.prototype.push.apply(out, all(root, FIELDS));
  all(root, '*').forEach(function (el) {
    var shadow = shadowOf(el);
    if (shadow) deepFields(shadow, out);
    var t = tagOf(el);
    var inner = t === 'IFRAME' ? iframeDocOf(el) : t === 'FRAME' ? frameDocOf(el) : null;
    if (inner) deepFields(inner, out);
  });
  return out;
}
var type = tag === 'INPUT' ? inputType(target) : '';
facts.isFileInput = type === 'file';
facts.isTextEntry = (tag === 'INPUT' && NOT_TEXT.indexOf(type) < 0) || tag === 'TEXTAREA' ||
  !!target.isContentEditable;
var form = ('form' in target && target.form) || closest.call(target, 'form');
var region;
if (form) {
  facts.targetInForm = true;
  region = Array.prototype.slice.call(formElements(form)).concat(deepFields(form, []));
  facts.isSubmitter = (tag === 'BUTTON' && (attr.call(target, 'type') || 'submit').toLowerCase() === 'submit') ||
    (tag === 'INPUT' && (type === 'submit' || type === 'image'));
  var action = (facts.isSubmitter && attr.call(target, 'formaction')) || attr.call(form, 'action') || urlOf(doc);
  facts.formAction = absolute(action);
} else {
  // Outside a form, a script login or checkout reads its fields from
  // anywhere on the page, a form included: every shown field is in reach.
  region = deepFields(doc, []).filter(visible);
}
facts.regionHasPassword = region.some(isPassword);
facts.regionHasPayment = region.some(isPayment);
var link = closest.call(target, 'a[href],area[href]');
if (link) facts.linkTarget = absolute(attr.call(link, 'href'));
return facts;
