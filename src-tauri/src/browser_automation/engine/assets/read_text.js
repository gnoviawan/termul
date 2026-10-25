var el = p.path ? byPath(p.path) : (bodyOf(document) || docElOf(document));
if (p.path && !el) return STALE;
var text = el ? textOf(el) : '';
var start = Math.min(p.cursor, text.length);
var first = text.charCodeAt(start);
if (first >= 0xDC00 && first <= 0xDFFF) start += 1;
var slice = clip(text.slice(start), p.limit);
return { text: slice, end: start + slice.length, length: text.length };
