"""Drop files on an X11 window the way a file manager does, over the XDND protocol.

Usage: uv run --with python-xlib==0.33 python -I xdnd-drop.py WxH X Y PATH...  (DISPLAY from the environment)

WxH picks the top-level window of that size; X Y is the drop point in its
coordinates. The script owns XdndSelection, sends XdndEnter and XdndPosition,
answers the target's request for text/uri-list, sends XdndDrop once the
target accepts, and waits for XdndFinished. It prints one line per protocol
step and exits non-zero if the target never accepts or never finishes.
"""

import sys
import time
from urllib.parse import quote

from Xlib import X, display
from Xlib.protocol import event

width, height = (int(part) for part in sys.argv[1].split("x"))
drop_x, drop_y = int(sys.argv[2]), int(sys.argv[3])
uris = "".join(f"file://{quote(path)}\r\n" for path in sys.argv[4:]).encode()

dpy = display.Display()
root = dpy.screen().root
atom = dpy.intern_atom

targets = [
    window
    for window in root.query_tree().children
    if (lambda g: g.width == width and g.height == height)(window.get_geometry())
]
if not targets:
    sys.exit(f"no {width}x{height} window")
target = targets[0]
aware = target.get_full_property(atom("XdndAware"), X.AnyPropertyType)
if aware is None:
    sys.exit("target window is not XdndAware")
version = min(5, aware.value[0])
print(f"target 0x{target.id:x} XdndAware version {aware.value[0]}")

origin = target.translate_coords(root, 0, 0)
root_x, root_y = -origin.x + drop_x, -origin.y + drop_y

source = root.create_window(0, 0, 1, 1, 0, X.CopyFromParent, X.InputOnly, X.CopyFromParent)
uri_list = atom("text/uri-list")
selection = atom("XdndSelection")
source.set_selection_owner(selection, X.CurrentTime)


def send(kind, data):
    message = event.ClientMessage(window=target, client_type=atom(kind), data=(32, data))
    target.send_event(message, event_mask=0)
    dpy.flush()


send("XdndEnter", [source.id, version << 24, uri_list, 0, 0])
send("XdndPosition", [source.id, 0, (root_x << 16) | root_y, X.CurrentTime, atom("XdndActionCopy")])
print(f"position sent at window ({drop_x}, {drop_y}), root ({root_x}, {root_y})")

dropped = False
deadline = time.time() + 10
while time.time() < deadline:
    if not dpy.pending_events():
        time.sleep(0.01)
        continue
    e = dpy.next_event()
    if e.type == X.SelectionRequest:
        if e.target == uri_list:
            e.requestor.change_property(e.property, uri_list, 8, uris)
            prop = e.property
        else:
            prop = X.NONE
        notify = event.SelectionNotify(
            time=e.time, requestor=e.requestor, selection=e.selection, target=e.target, property=prop
        )
        e.requestor.send_event(notify, event_mask=0)
        dpy.flush()
        print(f"selection served as {dpy.get_atom_name(e.target)}")
    elif e.type == X.ClientMessage:
        name = dpy.get_atom_name(e.client_type)
        if name == "XdndStatus":
            accepted = e.data[1][1] & 1
            print(f"status accepted={accepted}")
            if accepted and not dropped:
                send("XdndDrop", [source.id, 0, X.CurrentTime, 0, 0])
                dropped = True
                print("drop sent")
        elif name == "XdndFinished":
            print("finished")
            sys.exit(0 if dropped else 1)
sys.exit("timed out: " + ("no XdndFinished" if dropped else "target never accepted"))
