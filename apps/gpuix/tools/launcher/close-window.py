"""Close a top-level X11 window the way a window manager's close button does.

Usage: python -I close-window.py WIDTHxHEIGHT  (DISPLAY from the environment)

Sends WM_DELETE_WINDOW to the window of that size, which is what GPUI
handles as a user closing the window.
"""

import sys

from Xlib import X, display
from Xlib.protocol import event

width, height = (int(part) for part in sys.argv[1].split("x"))
dpy = display.Display()
wm_protocols = dpy.intern_atom("WM_PROTOCOLS")
wm_delete = dpy.intern_atom("WM_DELETE_WINDOW")

targets = []
for window in dpy.screen().root.query_tree().children:
    geometry = window.get_geometry()
    if geometry.width == width and geometry.height == height:
        protocols = window.get_wm_protocols() or []
        if wm_delete in protocols:
            targets.append(window)

if not targets:
    sys.exit(f"no {width}x{height} window that accepts WM_DELETE_WINDOW")
for window in targets:
    message = event.ClientMessage(
        window=window, client_type=wm_protocols, data=(32, [wm_delete, X.CurrentTime, 0, 0, 0])
    )
    window.send_event(message, event_mask=X.NoEventMask)
dpy.flush()
print(f"sent WM_DELETE_WINDOW to {len(targets)} window(s)")
