var a = deepActive();
return { editable: !!a && a !== a.ownerDocument.body && (a.matches(':read-write') || a.isContentEditable) };
