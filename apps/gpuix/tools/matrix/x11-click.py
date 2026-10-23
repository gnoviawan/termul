"""Click at a screen point with real X input (XTEST), the way a mouse would.

Usage: uv run --with python-xlib==0.33 python -I x11-click.py X Y [BUTTON]  (DISPLAY from the environment)

BUTTON is the X button number: 1 left, 2 middle, 3 right. The event goes
through the X server and GPUI's platform layer, not GPUIX's simulated input,
so it tells a harness gap apart from a product gap.
"""

import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

x, y = int(float(sys.argv[1])), int(float(sys.argv[2]))
button = int(sys.argv[3]) if len(sys.argv) > 3 else 1
dpy = display.Display()
xtest.fake_input(dpy, X.MotionNotify, x=x, y=y)
dpy.sync()
# No window manager runs under Xvfb, so nothing gives the window focus on a click.
pointer = dpy.screen().root.query_pointer()
if pointer.child:
    pointer.child.set_input_focus(X.RevertToParent, X.CurrentTime)
    dpy.sync()
time.sleep(0.05)
xtest.fake_input(dpy, X.ButtonPress, button)
dpy.sync()
time.sleep(0.05)
xtest.fake_input(dpy, X.ButtonRelease, button)
dpy.sync()
print(f"clicked button {button} at {x},{y}")
