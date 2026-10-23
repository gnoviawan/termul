"""Resize the top-level X11 window of one size, as a user dragging its edge would.

Usage: uv run --with python-xlib==0.33 python -I resize-window.py FROM_WxH TO_WxH  (DISPLAY from the environment)

There is no window manager under Xvfb, so the client's own configure request
is the resize; GPUI sees the ConfigureNotify and lays out again.
"""

import sys

from Xlib import display

from_w, from_h = (int(part) for part in sys.argv[1].split("x"))
to_w, to_h = (int(part) for part in sys.argv[2].split("x"))
dpy = display.Display()

targets = [
    window
    for window in dpy.screen().root.query_tree().children
    if (lambda g: g.width == from_w and g.height == from_h)(window.get_geometry())
]
if not targets:
    sys.exit(f"no {from_w}x{from_h} window")
for window in targets:
    window.configure(width=to_w, height=to_h)
dpy.sync()
print(f"resized {len(targets)} window(s) to {to_w}x{to_h}")
