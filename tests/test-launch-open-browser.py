#!/usr/bin/env python3
"""open_browser reaches every launcher (1.8.0, roadmap #7, PR #58).

PR #58 asked for a way to start GobboNet without a new browser tab, for people
who keep one open or use a phone. It added a flag to launch.bat's legacy branch,
which 1.8.0 removes, and a menu launch cannot pass flags anyway. So the setting
is a config.toml key, open_browser (default true), read by every launcher; a
--no-browser flag still beats it.

  A. The Linux launcher, run for real: a stand-in `gobbonet` answers the few
     commands it asks (setup --status, config get, serve) and a stand-in
     xdg-open records what would have opened.
  B. launch.bat's hand-over to gobbonet.exe, checked statically (it only runs
     in a Windows console): it reads the key without for /f, honours
     GOBBONET_OPEN_BROWSER=false from `gobbonet launch --no-browser`, keeps
     the house rules, and no unconditional --open is left on the Go path.

Run: python3 tests/test-launch-open-browser.py
"""
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
passed = failed = 0


def ok(cond, label, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS  ' + label)
    else:
        failed += 1
        print('  FAIL  ' + label + (('\n        ' + str(extra)[:600]) if extra else ''))


def freeport():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


FAKE_GOBBONET = r'''#!/usr/bin/env bash
# Stand-in for the gobbonet binary: only what gobbonet-launch asks of it.
case "${1:-} ${2:-}" in
    "setup --status") exit 0 ;;
    "config get")
        case "${3:-}" in
            open_browser) printf '%s\n' "${FAKE_OPEN_BROWSER:-true}" ;;
            listen_port)  printf '%s\n' "$FAKE_PORT" ;;
            data_dir)     printf '%s\n' "$FAKE_DATA" ;;
            *)            printf '\n' ;;
        esac
        exit 0 ;;
    "config set") exit 0 ;;
    "serve "*)
        exec python3 -c '
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = b"{\"status\":\"ok\"}"
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.HTTPServer(("127.0.0.1", int(os.environ["FAKE_PORT"])), H).serve_forever()
' ;;
esac
echo "fake gobbonet: unexpected: $*" >&2
exit 3
'''


def run_launcher(open_browser, args=()):
    """Run gobbonet-launch until it has either opened a browser or said it
    will not; return (urls opened, launch.log text)."""
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        prefix = t / 'lib'
        prefix.mkdir()
        shutil.copy(ROOT / 'installer-linux' / 'gobbonet-launch', prefix / 'gobbonet-launch')
        (prefix / 'gobbonet').write_text(FAKE_GOBBONET)
        for f in ('gobbonet-launch', 'gobbonet'):
            (prefix / f).chmod(0o755)
        fakebin = t / 'bin'
        fakebin.mkdir()
        browser = t / 'browser.log'
        (fakebin / 'xdg-open').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$BROWSER_LOG"\n')
        (fakebin / 'xdg-open').chmod(0o755)
        data = t / 'data'
        env = dict(os.environ, PATH=f'{fakebin}:{os.environ["PATH"]}', BROWSER_LOG=str(browser), DISPLAY=':99',
                   XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(t / 'config'), FAKE_PORT=str(freeport()),
                   FAKE_DATA=str(data / 'gobbonet'), FAKE_OPEN_BROWSER=open_browser)
        env.pop('WAYLAND_DISPLAY', None)
        p = subprocess.Popen([str(prefix / 'gobbonet-launch'), *args], env=env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log = data / 'gobbonet' / 'launch.log'
        text = ''
        try:
            for _ in range(200):
                text = log.read_text() if log.exists() else ''
                if browser.exists() or 'browser not opened' in text or p.poll() is not None:
                    break
                time.sleep(0.1)
            time.sleep(0.3)
            text = log.read_text() if log.exists() else ''
            urls = browser.read_text().split() if browser.exists() else []
        finally:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
        return urls, text


print('\n=== A. the Linux launcher ===')
if shutil.which('python3') is None:
    print('  SKIP  no python3 for the stand-in server')
else:
    urls, log = run_launcher('true')
    ok(len(urls) == 1 and urls[0].startswith('http://127.0.0.1:'), 'open_browser = true (the default): the chat opens, as before', log[-400:])

    urls, log = run_launcher('false')
    ok(urls == [], 'open_browser = false: no browser is opened', urls)
    ok('browser not opened (open_browser = false in config.toml); the chat is at http://127.0.0.1:' in log,
       'and the log says why, and where the chat is', log[-400:])

    urls, log = run_launcher('true', ['--no-browser'])
    ok(urls == [] and 'browser not opened (--no-browser)' in log, '--no-browser beats open_browser = true', log[-400:])

    LAUNCH = (ROOT / 'installer-linux' / 'gobbonet-launch').read_text()
    ok((ROOT / 'linux-amd64' / 'gobbonet-launch').read_text() == LAUNCH, 'the ZIP copy of the launcher is identical')
    setup_at = LAUNCH.index('echo "setup: first run"')
    first_read = LAUNCH.index('read_open_browser\n', LAUNCH.index('read_open_browser() {') + 30)
    ok(first_read > setup_at, 'the key is not read before a first run (config get would write a default config)')
    ok('[ "$FORCE_SETUP" = "1" ] && "$BIN" setup --status' in LAUNCH[setup_at:setup_at + 400],
       'setup run again on a configured install follows the key too')
    ok('[ "$BROWSER_WHY" = "--no-browser" ] || tell_url "$WIZARD"' in LAUNCH,
       'a setup the key keeps out of the browser still shows its address')

print('\n=== B. launch.bat ===')
RAW = (ROOT / 'launch.bat').read_bytes()
ok(RAW.count(b'\n') == RAW.count(b'\r\n'), 'launch.bat is still CRLF throughout')
BAT = RAW.decode('ascii').replace('\r\n', '\n')
# The whole script is the gobbonet.exe path since 1.8.0 removed :launch_legacy.
ok('\n:launch_legacy\n' not in BAT, 'there is no legacy branch left to open a browser of its own')
go_path = BAT
ok(re.search(r'^"!GN!" !GN_OPEN! --model "!GGUF_BASENAME!"$', go_path, re.M) is not None,
   'the hand-over to gobbonet.exe opens the browser through !GN_OPEN!')
ok([l for l in go_path.splitlines() if '--open' in l and not l.startswith('::')] == ['set "GN_OPEN=--open"'],
   'no unconditional --open is left on the gobbonet.exe path', [l for l in go_path.splitlines() if '--open' in l])
block = go_path[go_path.index('set "GN_OPEN=--open"'):go_path.index('"!GN!" !GN_OPEN!')]
ok('"!GN!" config get open_browser > "!GN_OPEN_FILE!" 2>nul' in block and 'set /p GN_OPEN_VAL=<"!GN_OPEN_FILE!"' in block,
   'it reads open_browser through a file')
ok('for /f' not in block, 'not through for /f, so the install path never meets cmd quoting')
ok('if /i "!GN_OPEN_VAL!"=="false" set "GN_OPEN="' in block, 'false in config.toml means no browser')
ok('if /i "!GOBBONET_OPEN_BROWSER!"=="false" set "GN_OPEN="' in block, 'gobbonet launch --no-browser (GOBBONET_OPEN_BROWSER=false) beats the file')
ok('del /q "!GN_OPEN_FILE!"' in block, 'and the temporary file is removed')
echo = [l for l in block.splitlines() if l.startswith('if not defined GN_OPEN echo')]
ok(len(echo) == 1 and '^(open_browser = false^)' in echo[0], 'it says so, with its parentheses escaped')
ok('nopageload' not in go_path.lower(), "PR #58's legacy-only flag went with the legacy branch")
ok('start "" "http' not in go_path, 'launch.bat opens no browser itself; gobbonet.exe --open does')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
