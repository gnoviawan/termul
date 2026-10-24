"""Log every screen update on an X display, for client-agnostic frame timing.

A DAMAGE object in raw-rectangle mode on every top-level window yields one
event per drawing request that reaches the window (a swapchain present,
whatever the toolkit). Damage on the root alone misses drawing into child
windows, so new top-levels are tracked through SubstructureNotify. Each event
prints `<epoch ms> <window> <x> <y> <w> <h>`; the runner groups them into frames.

uv run --with python-xlib==0.33 python -I x-frames.py   (DISPLAY set)
"""

import sys
import time

from Xlib import X, display
from Xlib.ext import damage

d = display.Display()
# Short-lived windows vanish before their DamageCreate lands; that BadDrawable is expected.
d.set_error_handler(lambda *_: None)
if not d.has_extension("DAMAGE"):
    sys.exit("no DAMAGE extension")
d.damage_query_version()
root = d.screen().root
root.change_attributes(event_mask=X.SubstructureNotifyMask)
tracked = set()


def track(win):
    if win.id in tracked:
        return
    tracked.add(win.id)
    win.damage_create(damage.DamageReportRawRectangles)


for child in root.query_tree().children:
    track(child)
d.flush()
print("ready", flush=True)
out = sys.stdout
while True:
    ev = d.next_event()
    # The registered event class is not damage.DamageNotify itself, so match by name.
    if type(ev).__name__ == "DamageNotify":
        a = ev.area
        out.write(f"{time.time() * 1000:.1f} {ev.drawable.id} {a.x} {a.y} {a.width} {a.height}\n")
        out.flush()
    elif ev.type in (X.CreateNotify, X.MapNotify):
        track(ev.window)
        d.flush()
