"""Real X input for the browser-pane checks, through XTest (GPUIX automation input never reaches X).

Usage: uv run --with python-xlib==0.33 python -I xinput.py CMD...  (DISPLAY from the environment)
  click X Y     move the pointer to root X,Y and press button 1
  move X Y      move the pointer only
  type TEXT     type ASCII letters, digits, spaces, : / . - _ and \\n (Return)
  key COMBO     press a keysym combination, as Control_L+a or Escape
  clipboard     print the CLIPBOARD selection as text
  focus         print the X input focus window id
"""

import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

dpy = display.Display()
cmd = sys.argv[1]
if cmd in ("click", "move"):
    x, y = int(sys.argv[2]), int(sys.argv[3])
    xtest.fake_input(dpy, X.MotionNotify, x=x, y=y)
    dpy.sync()
    if cmd == "click":
        time.sleep(0.05)
        xtest.fake_input(dpy, X.ButtonPress, 1)
        dpy.sync()
        time.sleep(0.03)
        xtest.fake_input(dpy, X.ButtonRelease, 1)
    dpy.sync()
elif cmd == "type":
    names = {" ": "space", ":": "colon", "/": "slash", ".": "period", "-": "minus", "_": "underscore", "\n": "Return"}
    shift = dpy.keysym_to_keycode(XK.string_to_keysym("Shift_L"))
    for ch in sys.argv[2]:
        sym = XK.string_to_keysym(names.get(ch, ch))
        code = dpy.keysym_to_keycode(sym)
        shifted = dpy.keycode_to_keysym(code, 0) != sym
        if shifted:
            xtest.fake_input(dpy, X.KeyPress, shift)
        xtest.fake_input(dpy, X.KeyPress, code)
        xtest.fake_input(dpy, X.KeyRelease, code)
        if shifted:
            xtest.fake_input(dpy, X.KeyRelease, shift)
        dpy.sync()
        time.sleep(0.03)
elif cmd == "key":
    codes = [dpy.keysym_to_keycode(XK.string_to_keysym(name)) for name in sys.argv[2].split("+")]
    for code in codes:
        xtest.fake_input(dpy, X.KeyPress, code)
    for code in reversed(codes):
        xtest.fake_input(dpy, X.KeyRelease, code)
    dpy.sync()
elif cmd == "clipboard":
    win = dpy.screen().root.create_window(0, 0, 1, 1, 0, dpy.screen().root_depth)
    clipboard, utf8, prop = (dpy.intern_atom(n) for n in ("CLIPBOARD", "UTF8_STRING", "B2_CLIP"))
    win.convert_selection(clipboard, utf8, prop, X.CurrentTime)
    dpy.flush()
    deadline = time.time() + 3
    while time.time() < deadline:
        if dpy.pending_events():
            ev = dpy.next_event()
            if ev.type == X.SelectionNotify:
                if ev.property != X.NONE:
                    data = win.get_full_property(prop, X.AnyPropertyType)
                    value = data.value if data else b""
                    print(value.decode() if isinstance(value, bytes) else value)
                break
        else:
            time.sleep(0.02)
elif cmd == "focus":
    print(hex(dpy.get_input_focus().focus.id))
else:
    sys.exit(f"unknown command {cmd}")
