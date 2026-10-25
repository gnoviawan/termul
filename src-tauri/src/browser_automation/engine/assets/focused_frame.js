var a = deepActive();
var tag = a && tagOf(a);
return FRAME_TAGS.indexOf(tag) >= 0 && !frameDocOf(a) ? pathOf(a) : null;
