"""Real X input through XTEST: move the pointer, or move and click button 1.

Usage: uv run --with python-xlib==0.33 python -I x11-press.py X Y focus|nofocus|move

`focus` gives the window under the pointer input focus before the press, as
tools/matrix/x11-click.py does (no window manager runs under Xvfb).
"""

import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

x, y, how = int(float(sys.argv[1])), int(float(sys.argv[2])), sys.argv[3]
dpy = display.Display()
xtest.fake_input(dpy, X.MotionNotify, x=x, y=y)
dpy.sync()
if how != "move":
    if how == "focus":
        pointer = dpy.screen().root.query_pointer()
        if pointer.child:
            pointer.child.set_input_focus(X.RevertToParent, X.CurrentTime)
            dpy.sync()
    time.sleep(0.05)
    xtest.fake_input(dpy, X.ButtonPress, 1)
    dpy.sync()
    time.sleep(0.05)
    xtest.fake_input(dpy, X.ButtonRelease, 1)
    dpy.sync()
