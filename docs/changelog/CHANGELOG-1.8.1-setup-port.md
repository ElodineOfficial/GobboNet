# 1.8.1 — Linux setup: a port just freed by GobboNet is not "in use"

Linux only: the `.deb`, `.rpm`, AppImage and ZIP, whose setup page is
`gobbonet-setup.py`. Present since 1.7.9.

## What was happening

Close GobboNet, run `gobbonet setup` again within about a minute, press
Continue on the port step with the port it was using, and setup said
`[Errno 98] Address already in use`. Waiting a minute and pressing Continue
again worked.

`POST /api/port` tested the port with a plain `bind()` to `0.0.0.0`. When
GobboNet closes, its end of every connection a browser tab had open goes to
TIME_WAIT on that port for 60 seconds, and on Linux a socket without
`SO_REUSEADDR` cannot bind a port that has TIME_WAIT connections. GobboNet
itself is not stopped by them: Go sets `SO_REUSEADDR` on every listener on
Linux, which TIME_WAIT does not block and a listening socket still does.
Reproduced against the 1.8.0 binary: with the chat's connections open, then
GobboNet stopped, the plain bind failed for 61 seconds while a bind with
`SO_REUSEADDR` succeeded at once, and `gobbonet serve` started on that port at
once in the same window. While GobboNet was still running, both binds failed.

The Go server's own port check, `POST /lan`, uses `net.Listen`, so it already
behaved like the server; only the Python setup had this.

## The change

`port_free(port)` in `installer-linux/gobbonet-setup.py` (and its identical
copy in `linux-amd64/`) binds with `SO_REUSEADDR`, the way the server will
listen, so its answer is the server's. A port a program is listening on, on
any address, is still refused. The refusal is now a sentence instead of
Python's errno text:

> Port 9066 is already in use, by a GobboNet that is still running or by
> another program. Stop it, or choose another port.

Other bind errors pass through as before. `TROUBLESHOOTING.md`'s port section
has the Linux side now, and `PATCH-README.txt` lists it under FIXED.

## Tests

- `tests/test-setup-port.py` (new; needs nothing built): `port_free()` from
  both copies, against real sockets. A free port is accepted. Ports listened
  on from loopback and from every address, with and without `SO_REUSEADDR`,
  are refused with the new message. A port left in TIME_WAIT by a server that
  closed first: the test first checks that 1.8.0's plain bind refuses it (so
  the case is reproduced, not assumed), then that `port_free()` accepts it and
  a server can listen there at once. 23 checks; against 1.8.0's setup,
  `port_free()` does not exist and the handler still binds by itself.
- `tests/test-linux-onboarding.py`: through the real setup page, a port in
  TIME_WAIT is accepted (200) and a port being listened on is refused (400,
  "already in use"), in both the local and the LAN first run. Against 1.8.0's
  setup it stops at the first: `400 [Errno 98] Address already in use`.
- `tests/console/1.8.1-setup-port.js`, a console check for the setup page:
  the page's own port must be refused in words; the saved port is tried, and
  a refusal is checked against whether anything is answering on it. Run in
  headless Chrome on the real setup page, opened just after a real
  `gobbonet serve` on the saved port was stopped with three connections open:
  2 of 2. With that GobboNet left running: 2 of 2, the saved port rightly
  refused. With 1.8.0's setup: reports that the setup is older than the fix.

Not run: a real desktop session (the setup page was opened directly, not from
the launcher's menu entry), the `.deb`, `.rpm` and AppImage builds (they copy
this file unchanged; built and checked in their own steps), and kernels other
than this workspace's Linux.
