var a = deepActive();
return { editable: !!a && a !== bodyOf(ownerDocOf(a)) && (matchesOf(a, ':read-write') || editableOf(a)) };
