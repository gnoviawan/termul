"""Print the X server's XInput version and its pointer devices, with their classes.

Usage: uv run --with python-xlib==0.33 python -I xi-devices.py  (DISPLAY from the environment)

GPUI needs XInput 2 and takes presses and motion from XI2 events on the master
pointer; it logs "Found no xinput mouse pointers" when no slave pointer has a
scroll class, which only disables smooth-scroll valuators.
"""

from Xlib import display
from Xlib.ext import xinput

dpy = display.Display()
if not dpy.has_extension("XInputExtension"):
    print("XInputExtension: absent")
    raise SystemExit(0)
version = dpy.xinput_query_version()
print(f"XInputExtension: {version.major_version}.{version.minor_version}")
kinds = {xinput.MasterPointer: "master pointer", xinput.SlavePointer: "slave pointer"}
for info in dpy.xinput_query_device(xinput.AllDevices).devices:
    if info.use not in kinds:
        continue
    scroll = any(c.type == xinput.ScrollClass for c in info.classes)
    print(f"  {info.deviceid:>3} {kinds[info.use]:<14} {info.name!r} scroll-class={scroll}")
