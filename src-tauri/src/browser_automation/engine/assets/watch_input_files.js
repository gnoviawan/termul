// Issued before the chooser opens: resolves true once the file input fires
// a trusted `input` or `change` (WebKit sets the files, then fires both),
// false after p.ms. A page that clears the input in its handler leaves it
// empty, so this is how the upload knows the page got the files anyway.
// The upload ends the watch early through end_input_watch with p.id, once
// it settled either way. The hook to do so sits on this world's own
// document wrapper, under a symbol key: page script never sees it.
var el = byPath(p.path);
if (!el || tagOf(el) !== 'INPUT' || inputType(el) !== 'file') return false;
var listen = method(EventTarget.prototype, 'addEventListener');
var unlisten = method(EventTarget.prototype, 'removeEventListener');
var key = Symbol.for('termul.inputWatches');
var watches = document[key] || (document[key] = Object.create(null));
return new Promise(function (resolve) {
  var timer;
  function finish(heard) {
    clearTimeout(timer);
    delete watches[p.id];
    unlisten(el, 'input', onEvent, true);
    unlisten(el, 'change', onEvent, true);
    resolve(heard);
  }
  // Capture listeners also see events from descendants (a page can append
  // and click a checkbox inside the input): only the input's own count.
  function onEvent(e) {
    if (e.isTrusted && e.target === el) finish(true);
  }
  listen(el, 'input', onEvent, true);
  listen(el, 'change', onEvent, true);
  watches[p.id] = function () {
    finish(false);
  };
  timer = setTimeout(function () {
    finish(false);
  }, p.ms);
});
