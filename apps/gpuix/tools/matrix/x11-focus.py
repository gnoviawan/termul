"""Give the X input focus to the top-level window at a screen point.

Usage: uv run --with python-xlib==0.33 python -I x11-focus.py X Y  (DISPLAY from the environment)

No window manager runs under Xvfb, so no window is ever active and GPUI
delivers no focus or blur events: a field never shows the focus ring the web
page (always focused under Playwright) shows. Focusing the window once makes
it the active window a user has.
"""

import sys

from Xlib import X, display

x, y = int(float(sys.argv[1])), int(float(sys.argv[2]))
dpy = display.Display()
root = dpy.screen().root
window = root.translate_coords(root, x, y).child
if not window:
    sys.exit(f"no window at {x},{y}")
window.set_input_focus(X.RevertToParent, X.CurrentTime)
dpy.sync()
print(f"focused window {window.id:#x}")
