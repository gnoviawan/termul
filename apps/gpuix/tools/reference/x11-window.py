"""Place the mapped top-level window titled NAME at X,Y with size WxH, and give it the X input focus.

Usage: uv run --with python-xlib==0.33 python -I x11-window.py NAME X Y W H  (DISPLAY from the environment)

No window manager runs under Xvfb, so a client's ConfigureWindow request is
applied as sent, and nothing focuses a window on its own.
"""

import sys
import time

from Xlib import X, display, error

name = sys.argv[1]
x, y, w, h = (int(v) for v in sys.argv[2:6])
dpy = display.Display()
root = dpy.screen().root


def title(win):
    value = win.get_wm_name()
    return value.decode() if isinstance(value, bytes) else value


def find():
    for win in root.query_tree().children:
        try:
            if title(win) == name and win.get_attributes().map_state == X.IsViewable:
                return win
        except error.BadWindow:
            pass  # a window the app destroyed while the tree was walked
    return None


deadline = time.time() + 60
win = find()
while win is None:
    if time.time() > deadline:
        sys.exit(f"no mapped window titled {name!r}")
    time.sleep(0.2)
    win = find()

win.configure(x=x, y=y, width=w, height=h)
dpy.sync()
deadline = time.time() + 10
while True:
    g = win.get_geometry()
    if (g.x, g.y, g.width, g.height) == (x, y, w, h):
        break
    if time.time() > deadline:
        sys.exit(f"window stayed at {g.width}x{g.height}+{g.x}+{g.y}")
    time.sleep(0.1)
win.set_input_focus(X.RevertToParent, X.CurrentTime)
dpy.sync()
print(f"{win.id:#x} {w}x{h}+{x}+{y}")
