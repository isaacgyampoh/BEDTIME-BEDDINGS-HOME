"""A stand-in ESC/POS receipt printer on a pseudo-terminal.

serialport opens the slave end exactly as it would open COM3 on the till, so
the real native module, real baud-rate setting and real byte stream are all
exercised. Behaves like the hardware in the ways that matter:

  * answers DLE EOT n with a status byte ONLY when the line is set to its own
    speed; at any other speed it answers 0xFF, which is what a garbled reply
    looks like — so detection has to find the right speed, not just a port
  * can report paper out (DLE EOT 2 bit 5, DLE EOT 4 bits 5+6)
  * records everything printed at the right speed to a capture file, and
    counts bytes that arrived at the wrong speed (which would print as nothing
    or as garbage on a real head)

usage: fake_printer.py <baud> <capture-file> [paper_out 0|1]
prints the device path on stdout, then serves until killed.
"""
import os, sys, termios, tty, select

BAUD = int(sys.argv[1]); CAPTURE = sys.argv[2]
PAPER_OUT = len(sys.argv) > 3 and sys.argv[3] == '1'

master, slave = os.openpty()
tty.setraw(master)
print(os.ttyname(slave), flush=True)
open(CAPTURE, 'wb').close()
wrong_speed_bytes = 0
buf = b''

def speed():
    # The slave's attributes are shared with whoever else has the device open,
    # so this is the speed serialport configured.
    return termios.tcgetattr(slave)[5]

def reply(n):
    if speed() != BAUD:
        return b'\xff'
    if n == 2:
        return bytes([0x32 if PAPER_OUT else 0x12])
    if n == 4:
        return bytes([0x72 if PAPER_OUT else 0x12])
    return b'\x12'

while True:
    r, _, _ = select.select([master], [], [], 0.2)
    if not r:
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError:
        continue
    buf += chunk
    out = b''
    i = 0
    printed = b''
    while i < len(buf):
        if buf[i:i+2] == b'\x10\x04' and i + 2 < len(buf):
            out += reply(buf[i+2]); i += 3; continue
        if buf[i:i+2] == b'\x10\x04':
            break                        # wait for the rest of the command
        printed += buf[i:i+1]; i += 1
    buf = buf[i:]
    if out:
        os.write(master, out)
    if printed:
        if speed() == BAUD:
            with open(CAPTURE, 'ab') as f: f.write(printed)
        else:
            wrong_speed_bytes += len(printed)
            with open(CAPTURE + '.wrong', 'w') as f: f.write(str(wrong_speed_bytes))
