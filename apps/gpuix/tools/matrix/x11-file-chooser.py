"""Answer a GTK file chooser (xdg-desktop-portal-gtk) on an X display with real key events.

Usage: uv run --with python-xlib==0.33 python -I x11-file-chooser.py TITLE PATH [TIMEOUT_S]

Waits for the top-level window named TITLE ("Open File", "Save File"), gives
it the input focus, selects the field under the keyboard focus, types PATH and
presses Return, which accepts the dialog in both modes. An empty PATH presses
Escape instead (cancel). DISPLAY comes from the environment.
"""

import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

title, target = sys.argv[1], sys.argv[2]
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 15.0
dpy = display.Display()
root = dpy.screen().root

SHIFTED = {"_": "underscore", "~": "asciitilde", ":": "colon", "+": "plus"}
NAMED = {"/": "slash", ".": "period", "-": "minus", " ": "space", "=": "equal", ",": "comma"}


def find(window):
    if window.get_wm_name() == title:
        return window
    for child in window.query_tree().children:
        hit = find(child)
        if hit:
            return hit
    return None


def key(name, shift=False, ctrl=False):
    code = dpy.keysym_to_keycode(XK.string_to_keysym(name))
    if not code:
        sys.exit(f"no keycode for {name!r}")
    mods = [n for n, on in (("Shift_L", shift), ("Control_L", ctrl)) if on]
    for mod in mods:
        xtest.fake_input(dpy, X.KeyPress, dpy.keysym_to_keycode(XK.string_to_keysym(mod)))
    xtest.fake_input(dpy, X.KeyPress, code)
    xtest.fake_input(dpy, X.KeyRelease, code)
    for mod in reversed(mods):
        xtest.fake_input(dpy, X.KeyRelease, dpy.keysym_to_keycode(XK.string_to_keysym(mod)))
    dpy.sync()
    time.sleep(0.02)


deadline = time.monotonic() + timeout
window = None
while window is None:
    window = find(root)
    if window is None:
        if time.monotonic() > deadline:
            sys.exit(f"no window named {title!r} within {timeout}s")
        time.sleep(0.2)

# GTK maps the dialog before it can take keys.
time.sleep(1.0)
window.set_input_focus(X.RevertToParent, X.CurrentTime)
dpy.sync()
time.sleep(0.3)

if not target:
    key("Escape")
    print(f"cancelled {title!r} ({window.id:#x})")
    sys.exit(0)

if title == "Save File":
    key("a", ctrl=True)
else:
    key("l", ctrl=True)
time.sleep(0.3)
for ch in target:
    if ch in SHIFTED:
        key(SHIFTED[ch], shift=True)
    elif ch in NAMED:
        key(NAMED[ch])
    elif ch.isupper():
        key(ch.lower(), shift=True)
    else:
        key(ch)
time.sleep(0.5)
key("Return")
print(f"answered {title!r} ({window.id:#x}) with {target}")
