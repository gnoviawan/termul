var batches = [];
function take(e) {
  if (typeof e.detail === 'string') batches.push(e.detail);
}
function pull(win, depth) {
  try {
    win.addEventListener('termul-console-entries', take);
    win.dispatchEvent(new CustomEvent('termul-console-pull'));
    win.removeEventListener('termul-console-entries', take);
  } catch (e) {
    return;
  }
  if (depth >= 4) return;
  for (var i = 0; i < win.frames.length; i++) {
    var child = win.frames[i];
    try { if (!child.document) continue; } catch (e) { continue; }
    pull(child, depth + 1);
  }
}
pull(window, 0);
return { batches: batches };
