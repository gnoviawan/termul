var a = deepActive();
var tag = a && tagOf(a);
return (tag === 'IFRAME' || tag === 'FRAME') && !frameDocOf(a) ? pathOf(a) : null;
