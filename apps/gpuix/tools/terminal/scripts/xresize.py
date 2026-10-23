"""Resize an X window: xresize.py <display> <window-id-hex> <width> <height>.

Xvfb runs without a window manager, so a client can resize a top-level
window directly, the way a WM would on the user's request.
"""
import ctypes
import sys

display_name, window, width, height = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3]), int(sys.argv[4])
x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_uint, ctypes.c_uint]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
dpy = x11.XOpenDisplay(display_name.encode())
if not dpy:
    sys.exit(f"cannot open display {display_name}")
x11.XResizeWindow(dpy, window, width, height)
x11.XFlush(dpy)
x11.XCloseDisplay(dpy)
