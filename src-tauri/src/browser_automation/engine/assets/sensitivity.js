var target = p.path ? locate(p.path) : deepActive();
if (p.path && !target) return STALE;
var facts = {
  frameOrigin: location.origin,
  targetInForm: false,
  regionHasPassword: false,
  regionHasPayment: false,
  pageHasPayment: false,
  isSubmitter: false,
  submitsByScript: false,
  isTextEntry: false,
  isFileInput: false,
  formAction: null,
  linkTarget: null,
  opaqueFrames: []
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
var NOT_TEXT = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range', 'hidden'];
function isPassword(el) {
  if (tagOf(el) === 'INPUT' && inputType(el) === 'password') return true;
  return tokens(el).some(function (t) {
    return t === 'current-password' || t === 'new-password' || t === 'one-time-code';
  });
}
function isNativeSubmitter(el) {
  var t = tagOf(el);
  if (t === 'BUTTON') return (attr(el, 'type') || 'submit').toLowerCase() === 'submit';
  return t === 'INPUT' && (inputType(el) === 'submit' || inputType(el) === 'image');
}
// A shown frame of another origin: its fields are out of this helper's
// reach. A payment provider's hosted card fields sit in one; providers
// name the frame for what it takes.
function isOpaqueFrame(el) {
  return !frameDocOf(el) && visible(el);
}
var PAYMENT_FRAME = /payment|credit|card.?(number|field|input|frame|form)|cvc|cvv|security.?code|expir/i;
function namesPayment(el) {
  return /payment/i.test(attr(el, 'allow') || '') ||
    PAYMENT_FRAME.test((attr(el, 'title') || '') + ' ' + (attr(el, 'name') || ''));
}
var MAX_OPAQUE_FRAMES = 8;
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
  facts.isSubmitter = isNativeSubmitter(target);
  // A button in a form with no submit button of its own: the page's
  // script is what submits that form.
  facts.submitsByScript = !facts.isSubmitter && !facts.isTextEntry &&
    roleOf(target) === 'button' && (attr(target, 'type') || '').toLowerCase() !== 'reset' &&
    !Array.prototype.slice.call(formElements(form)).some(isNativeSubmitter);
  var action = (facts.isSubmitter && attr(target, 'formaction')) || attr(form, 'action') || urlOf(doc);
  facts.formAction = absolute(action);
} else {
  // Outside a form, a script login or checkout reads its fields from
  // anywhere on the page, a form included: every shown field is in reach.
  region = deepFields(doc, []).filter(visible);
}
var pageFrames = deepAll(doc, 'iframe,frame', []).filter(isOpaqueFrame);
var regionFrames = form ? deepAll(form, 'iframe,frame', []).filter(isOpaqueFrame) : pageFrames;
facts.regionHasPassword = region.some(isPassword);
facts.regionHasPayment = region.some(isPayment) || regionFrames.some(namesPayment);
// An order form without card fields can still charge the card: its script
// reads the fields another form on the page holds.
facts.pageHasPayment = facts.regionHasPayment || pageFrames.some(namesPayment) ||
  (!!form && deepFields(doc, []).filter(visible).some(isPayment));
// The host reads the other frames where its engine reaches them.
facts.opaqueFrames = pageFrames.filter(function (f) { return !namesPayment(f); })
  .slice(0, MAX_OPAQUE_FRAMES)
  .map(function (f) { return { path: pathOf(f), inRegion: regionFrames.indexOf(f) >= 0 }; });
var link = closestOf(target, 'a[href],area[href]');
if (link) facts.linkTarget = absolute(attr(link, 'href'));
return facts;
