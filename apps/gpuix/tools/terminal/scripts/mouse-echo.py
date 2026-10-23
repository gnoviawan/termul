"""Enable xterm mouse reporting (1000 + SGR 1006), print every report as hex, stop after one release."""
import os
import select
import sys
import termios
import time
import tty

fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
os.write(1, b"\x1b[?1000h\x1b[?1006hMOUSE-READY\r\n")
data = b""
deadline = time.time() + 20
try:
    while time.time() < deadline and not data.endswith(b"m"):
        if select.select([fd], [], [], 0.2)[0]:
            data += os.read(fd, 64)
finally:
    os.write(1, b"\x1b[?1006l\x1b[?1000l")
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
print("MOUSE=" + data.hex())
