"""Take the X input focus away from every window (give it to the root), as
switching to another app does. Usage: uv run --with python-xlib==0.33 python -I x11-unfocus.py"""

from Xlib import X, display

dpy = display.Display()
dpy.screen().root.set_input_focus(X.RevertToParent, X.CurrentTime)
dpy.sync()
print("focused the root window")
