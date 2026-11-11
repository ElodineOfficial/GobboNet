"""The launcher's password reaches gobbonet.exe before anything can stop the run.

Issue #63, "asked for the password twice". launch.bat stores the password as a
salt:hash pair in .gobbonet-secret, and used to copy it into gobbonet.exe's
config.toml only at :launch -- the very last step. A run that stopped earlier
(a cancelled download, the model menu, a closed window) left config.toml with
no password, and the Start menu shortcut, which runs `gobbonet.exe launch`,
then asked the user to choose one again.

A. STATIC: the early `config set access_secret` sits right after the secret is
   validated, ahead of the first prompt that can end the run, with the same
   (default) config file as the write at :launch. Since 1.8.0 it needs no
   guard: a missing gobbonet.exe stops launch.bat before the password prompt.
   That write creates config.toml on a first run, and `gobbonet.exe launch`
   (the 1.7.6 hotfix's shortcuts) serves any config it finds, so the run also
   leaves .gobbonet-setup-pending until :launch; launch.go reruns setup while
   the mark is there and the config names no engine. The uninstaller removes
   the mark.

B. BEHAVIOUR, against the built server (linux-amd64/gobbonet): with no secret,
   a server with no terminal refuses to start -- the non-interactive face of
   "asks for a password" -- and after the launcher's exact command, given a
   salt:hash made the way launch.bat makes one, it starts without asking and
   accepts that password, still upgrading it to Argon2id on first login.

Run: python3 tests/test-launch-secret-handoff.py
"""
import hashlib, os, pathlib, re, secrets, socket, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = (ROOT / "launch.bat").read_bytes().decode("ascii")
LINES = RAW.split("\r\n")
GN = pathlib.Path(os.environ.get("GOBBONET_TEST_BIN", str(ROOT / "linux-amd64" / "gobbonet")))

passed = failed = 0


def ok(cond, label, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + label)
    else:
        failed += 1
        print("  ✗ " + label + ("\n      " + str(extra) if extra else ""))


def line_of(pred):
    return next((i for i, l in enumerate(LINES) if pred(l)), None)


# ---------------------------------------------------------------------------
print("\n=== A. where launch.bat writes the password ===")
validated = line_of(lambda l: l.strip() == ":secret_shape_ok")
writes = [i for i, l in enumerate(LINES) if re.search(r"config set access_secret", l)]
first_stop = min(i for i in (
    line_of(lambda l: "Download llama.cpp now?" in l),
    line_of(lambda l: l.strip() == ":show_catalog"),
    line_of(lambda l: l.strip() == ":launch"),
) if i is not None)

ok(validated is not None, "the secret-validation label is still there")
ok(len(writes) == 2, "access_secret is written twice: early, and again at :launch", writes)
early = writes[0] if writes else None
ok(early is not None and validated is not None and validated < early < first_stop,
   "the early write comes after validation and before the first prompt that can end the run",
   f"validated={validated} early={early} first_stop={first_stop}")
between = [l for l in LINES[validated + 1:early] if l.strip() and not l.strip().startswith("::")] \
    if early is not None and validated is not None else ["?"]
ok(len(between) <= 1,
   "and immediately after validation: only the setup mark comes between, besides comments",
   between)
missing = line_of(lambda l: l.strip() == 'if not exist "%~dp0gobbonet.exe" goto :no_gobbonet_exe')
ok(missing is not None and early is not None and missing < validated,
   "gobbonet.exe is known to be there: a missing one stopped the run before the password (1.8.0)",
   (missing, validated))
ok(not any("GOBBONET_LEGACY_SERVER" in LINES[i] for i in range(validated, early + 1)) if early else False,
   "and there is no legacy-server guard to skip it any more")
ok(early is not None and "!ACCESS_SECRET!" in LINES[early] and "--config" not in LINES[early],
   "writes the validated value to the default config file, the one :launch writes")
ok(len(writes) == 2 and "--config" not in LINES[writes[1]] and "!ACCESS_SECRET!" in LINES[writes[1]],
   "the write at :launch is unchanged")
ok(RAW.count("\n") == RAW.count("\r\n"), "launch.bat is still CRLF throughout")

# The unfinished-setup mark, and that launch.go and the uninstaller agree on it.
MARK = ".gobbonet-setup-pending"
LAUNCH_GO = (ROOT / "cmd/gobbonet/launch.go").read_text()
NSI = (ROOT / "installer-win/gobbonet.nsi").read_text()
mark_at = line_of(lambda l: l.strip() == 'type nul > "%~dp0' + MARK + '" 2>nul')
ok(mark_at is not None and early is not None and mark_at == early - 1,
   "the early write first leaves " + MARK + ", on the line before", (mark_at, early))
launch_label = line_of(lambda l: l.strip() == ":launch")
clear_at = line_of(lambda l: l.strip() == 'if exist "%~dp0' + MARK + '" del /q "%~dp0' + MARK + '" >nul 2>&1')
ok(clear_at is not None and launch_label is not None and len(writes) == 2 and writes[1] < clear_at
   and "server_exe" in "".join(LINES[launch_label:writes[1]]),
   ":launch clears it, after writing the engine and the rest of the settings", (launch_label, writes, clear_at))
ok('const setupPendingName = "' + MARK + '"' in LAUNCH_GO, "launch.go looks for the same name")
ok('Delete "$INSTDIR\\' + MARK + '"' in NSI, "the Windows uninstaller removes it")


# ---------------------------------------------------------------------------
print("\n=== B. what the server does with it ===")
if not (GN.is_file() and os.access(GN, os.X_OK)):
    print(f"  - SKIPPED: {GN} is not built (make-zip.sh builds it, or set GOBBONET_TEST_BIN)")
else:
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect := type(
        "NoRedirect", (urllib.request.HTTPRedirectHandler,), {"redirect_request": lambda *a, **k: None})())

    def freeport():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def serve(cfg, port):
        return subprocess.Popen([str(GN), "serve", "--config", str(cfg), "--host", "127.0.0.1",
                                 "--port", str(port)], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)

    def wait_up(p, port, secs=15):
        end = time.time() + secs
        while time.time() < end:
            if p.poll() is not None:
                return False
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                    return True
            except OSError:
                time.sleep(0.1)
        return False

    def login(port, password):
        data = urllib.parse.urlencode({"password": password}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/login", data=data)
        try:
            r = http.open(req)
        except urllib.error.HTTPError as e:
            r = e
        return r.code, r.headers.get("Set-Cookie", "")

    with tempfile.TemporaryDirectory() as t:
        d = pathlib.Path(t)

        # B1. The state a stopped run used to leave: no access_secret at all.
        cfg = d / "config.toml"
        subprocess.run([str(GN), "config", "set", "--config", str(cfg), "model_dir", str(d)],
                       check=True, capture_output=True)
        port = freeport()
        p = serve(cfg, port)
        try:
            out = p.communicate(timeout=20)[0].decode(errors="replace")
        except subprocess.TimeoutExpired:
            p.kill(); out = p.communicate()[0].decode(errors="replace")
        ok(p.returncode not in (0, None) and "no password is set" in out,
           "with no password in config.toml the server will not start without asking for one",
           out.strip().splitlines()[-1:] if out else p.returncode)

        # B2. launch.bat's :setup_password result, then its exact command.
        password = "correct horse " + secrets.token_hex(3)
        salt = secrets.token_hex(16)
        legacy = salt + ":" + hashlib.sha256((salt + password).encode()).hexdigest()
        r = subprocess.run([str(GN), "config", "set", "--config", str(cfg), "access_secret", legacy],
                           capture_output=True)
        ok(r.returncode == 0, "`gobbonet config set access_secret <salt:hash>` accepts the launcher's format",
           r.stderr.decode(errors="replace"))

        port = freeport()
        p = serve(cfg, port)
        try:
            up = wait_up(p, port)
            ok(up, "with it, the server starts without asking for a password",
               "" if up else (p.communicate(timeout=5)[0].decode(errors="replace")[-400:]))
            if up:
                code, _ = login(port, "not the password")
                ok(code == 401, "a wrong password is refused", code)
                code, cookie = login(port, password)
                ok(code in (302, 303) and cookie, "the password chosen in launch.bat logs in", (code, cookie[:40]))
                time.sleep(0.3)
                stored = subprocess.run([str(GN), "config", "get", "--config", str(cfg), "access_secret"],
                                        capture_output=True).stdout.decode().strip()
                ok(stored.startswith("$argon2id$"),
                   "and the salt:hash is upgraded to Argon2id on that first login, as before", stored[:20])
        finally:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
