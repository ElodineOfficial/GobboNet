"""The Linux setup's port step, run again just after GobboNet was closed.

Up to 1.8.0 the setup page (gobbonet-setup.py, POST /api/port) tested the
chosen port with a plain bind. When GobboNet closes, each connection a browser
tab had open to it stays in TIME_WAIT for about a minute, and a plain bind
refuses the port while any of them is left -- so setup run again within a
minute of closing said "[Errno 98] Address already in use" about a port
GobboNet could have used at once: Go sets SO_REUSEADDR on every listener on
Linux, which TIME_WAIT does not block. port_free() now binds the same way, so
it asks the question the server will. A program still listening is refused
either way, with a message that says so.

This runs port_free() itself, out of both copies of gobbonet-setup.py, against
real sockets: a free port, ports with a program listening on them (with and
without SO_REUSEADDR, loopback and every address), and a port left in
TIME_WAIT by a server that closed first -- checking first that the old plain
bind really refuses that one, so the case is reproduced and not assumed. Then
a server listens there, as gobbonet serve would. The end-to-end version, through
the real setup page, is in tests/test-linux-onboarding.py.

Run: python3 tests/test-setup-port.py
"""
import importlib.util
import pathlib
import socket
import sys
import time

sys.dont_write_bytecode = True   # importing the setup must not leave __pycache__ in the tree
ROOT = pathlib.Path(__file__).resolve().parents[1]
COPIES = ["installer-linux/gobbonet-setup.py", "linux-amd64/gobbonet-setup.py"]
passed = failed = 0


def ok(cond, label, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + label)
    else:
        failed += 1
        print("  ✗ " + label + ("\n      " + str(extra) if extra else ""))


def load(rel):
    spec = importlib.util.spec_from_file_location("gobbonet_setup_" + rel.split("/")[0].replace("-", "_"), ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    saved = sys.argv
    sys.argv = [str(ROOT / rel)]          # it reads the engine path from argv[1]
    try:
        spec.loader.exec_module(mod)      # definitions only: the server starts under __main__
    finally:
        sys.argv = saved
    return mod


def verdict(port_free, port):
    try:
        port_free(port)
        return "free", ""
    except ValueError as e:
        return "busy", str(e)


def plain_bind(port):
    """The check 1.8.0 shipped: a bind with no options."""
    with socket.socket() as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def listener(host, reuse):
    s = socket.socket()
    if reuse:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, 0))
    s.listen()
    return s


def time_wait_port():
    """A port whose server closed while a browser was connected, as GobboNet
    does when it is stopped: the server's end goes to TIME_WAIT on that port."""
    srv = listener("127.0.0.1", True)          # as Go listens
    port = srv.getsockname()[1]
    tab = socket.create_connection(("127.0.0.1", port))
    conn, _ = srv.accept()
    srv.close()                                 # GobboNet stops listening
    conn.close()                                # and closes its connections first
    time.sleep(0.05)
    tab.close()                                 # the tab's end follows
    time.sleep(0.1)
    return port


for rel in COPIES:
    print(f"\n=== {rel} ===")
    mod = load(rel)
    pf = getattr(mod, "port_free", None)
    ok(callable(pf), "it has port_free()")
    if not callable(pf):
        continue

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        free = s.getsockname()[1]
    ok(verdict(pf, free)[0] == "free", "a port nothing uses: accepted")

    for host, reuse, what in (("127.0.0.1", True, "GobboNet still running, this PC only"),
                              ("0.0.0.0", True, "GobboNet still running, with LAN access"),
                              ("127.0.0.1", False, "another program listening on this PC only"),
                              ("0.0.0.0", False, "another program listening on every address")):
        with listener(host, reuse) as s:
            port = s.getsockname()[1]
            v, msg = verdict(pf, port)
            ok(v == "busy" and "already in use" in msg and str(port) in msg,
               f"{what}: refused, and the message says why", msg)
    with listener("127.0.0.1", True) as s:
        msg = verdict(pf, s.getsockname()[1])[1]
        ok("Errno" not in msg and "Stop it, or choose another port." in msg,
           "the message is words, not Python's errno text", msg)

    port = time_wait_port()
    reproduced = not plain_bind(port)
    if reproduced:
        ok(True, "the case is real here: 1.8.0's plain bind refuses a port left in TIME_WAIT")
        ok(verdict(pf, port)[0] == "free", "port_free accepts it, as GobboNet itself would")
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind(("127.0.0.1", port))
            srv.listen()
            served = True
        except OSError:
            served = False
        finally:
            srv.close()
        ok(served, "and a server can listen there at once, as gobbonet serve does")
    else:
        print("  - SKIPPED: this system did not leave the port in TIME_WAIT, so the case could not be reproduced")

print("\n=== the /api/port handler ===")
src = (ROOT / COPIES[0]).read_text()
handler = src.split("elif self.path == '/api/port':", 1)[1].split("elif self.path ==", 1)[0]
ok("port_free(port)" in handler and handler.index("port_free(port)") < handler.index("put('listen_port'"),
   "it checks with port_free() before saving the port")
ok("sock.bind" not in handler, "and no longer binds by itself")
ok((ROOT / COPIES[0]).read_bytes() == (ROOT / COPIES[1]).read_bytes(), "the ZIP's copy is the same file")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
