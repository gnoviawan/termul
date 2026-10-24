var target = p.path ? locate(p.path) : deepActive();
if (p.path && !target) return STALE;
var facts = {
  frameOrigin: location.origin,
  targetInForm: false,
  regionHasPassword: false,
  regionHasPayment: false,
  pageHasPayment: false,
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
if (!p.path && FRAME_TAGS.indexOf(tag) >= 0 && !frameDocOf(target)) {
  facts.targetInForm = facts.regionHasPassword = facts.regionHasPayment = facts.pageHasPayment =
    facts.isSubmitter = true;
  return facts;
}
function absolute(href) {
  try { return new URL(href, baseOf(doc)).href; } catch (e) { return null; }
}
function tokens(el) {
  return (attr(el, 'autocomplete') || '').toLowerCase().split(/\s+/);
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
  return CARD_NAME.test((attr(el, 'name') || '') + ' ' + (attr(el, 'id') || ''));
}
var FIELDS = 'input,select,textarea,[autocomplete]';
// Fields under root, open shadow roots and same-origin frames included.
function deepFields(root, out) {
  Array.prototype.push.apply(out, all(root, FIELDS));
  all(root, '*').forEach(function (el) {
    var shadow = shadowOf(el);
    if (shadow) deepFields(shadow, out);
    var inner = frameDocOf(el);
    if (inner) deepFields(inner, out);
  });
  return out;
}
var type = tag === 'INPUT' ? inputType(target) : '';
facts.isFileInput = type === 'file';
facts.isTextEntry = (tag === 'INPUT' && NOT_TEXT.indexOf(type) < 0) || tag === 'TEXTAREA' ||
  editableOf(target);
// A form's own `form` is whatever it holds under that name.
var owner = tag !== 'FORM' && 'form' in target ? target.form : null;
var form = owner || closestOf(target, 'form');
var region;
if (form) {
  facts.targetInForm = true;
  region = Array.prototype.slice.call(formElements(form)).concat(deepFields(form, []));
  facts.isSubmitter = (tag === 'BUTTON' && (attr(target, 'type') || 'submit').toLowerCase() === 'submit') ||
    (tag === 'INPUT' && (type === 'submit' || type === 'image'));
  var action = (facts.isSubmitter && attr(target, 'formaction')) || attr(form, 'action') || urlOf(doc);
  facts.formAction = absolute(action);
} else {
  // Outside a form, a script login or checkout reads its fields from
  // anywhere on the page, a form included: every shown field is in reach.
  region = deepFields(doc, []).filter(visible);
}
facts.regionHasPassword = region.some(isPassword);
facts.regionHasPayment = region.some(isPayment);
// An order form without card fields can still charge the card: its script
// reads the fields another form on the page holds.
facts.pageHasPayment = facts.regionHasPayment ||
  (!!form && deepFields(doc, []).filter(visible).some(isPayment));
var link = closestOf(target, 'a[href],area[href]');
if (link) facts.linkTarget = absolute(attr(link, 'href'));
return facts;
