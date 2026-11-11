// Ends the watch_input_files watch p.id once its upload settled, so its
// listeners and timer go now rather than when its budget runs out. True
// when the watch was still listening, false when it had already ended.
var watches = document[Symbol.for('termul.inputWatches')];
var end = watches && watches[p.id];
if (typeof end !== 'function') return false;
end();
return true;
