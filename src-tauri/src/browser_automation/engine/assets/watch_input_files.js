// Issued before the chooser opens: resolves true once the file input fires
// a trusted `input` or `change` (WebKit sets the files, then fires both),
// false after p.ms. A page that clears the input in its handler leaves it
// empty, so this is how the upload knows the page got the files anyway.
var el = byPath(p.path);
if (!el || tagOf(el) !== 'INPUT' || inputType(el) !== 'file') return false;
var listen = method(EventTarget.prototype, 'addEventListener');
var unlisten = method(EventTarget.prototype, 'removeEventListener');
return new Promise(function (resolve) {
  var timer;
  function finish(heard) {
    clearTimeout(timer);
    unlisten(el, 'input', onEvent, true);
    unlisten(el, 'change', onEvent, true);
    resolve(heard);
  }
  function onEvent(e) {
    if (e.isTrusted) finish(true);
  }
  listen(el, 'input', onEvent, true);
  listen(el, 'change', onEvent, true);
  timer = setTimeout(function () {
    finish(false);
  }, p.ms);
});
