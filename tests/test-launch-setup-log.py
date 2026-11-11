#!/usr/bin/env python3
"""A first run's setup log goes however the first run ends (1.8.0).

gobbonet-launch sends the setup page's output to a temporary file,
setup.XXXXXX in the default data folder, and watches it for the page's
address. Up to 1.8.0 it removed that file only when setup finished, and set
its trap only once the browser had opened: a first run abandoned (a logout, a
kill, Ctrl+C) or one whose setup failed left the file, and `gobbonet
uninstall`, which removes everything else the launcher writes there, left the
folder because of it. Found by installing the 1.8.0 .deb and stopping a first
run.

  A. The Linux launcher, run for real. A stand-in `gobbonet` says setup is not
     done; a stand-in gobbonet-setup.py prints its address and then waits, or
     fails. The launcher is stopped with SIGTERM, SIGHUP and SIGINT before
     and after the browser step, and its setup fails once. Each time: no
     setup.* file is left, what the setup page printed is in launch.log, and
     the setup page is not left running.
  B. The same script in the ZIP, and the finished path unchanged.

`gobbonet uninstall` removing the leftovers of older versions is
TestUninstallRemovesEveryConversationFileAndKeepsModels in
cmd/gobbonet/uninstall_test.go.

Run: python3 tests/test-launch-setup-log.py
"""
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
LAUNCH = ROOT / 'installer-linux' / 'gobbonet-launch'
passed = failed = 0


def ok(cond, label, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS  ' + label)
    else:
        failed += 1
        print('  FAIL  ' + label + (('\n        ' + str(extra)[:600]) if extra else ''))


# Only what gobbonet-launch asks of the program before and during a first run.
FAKE_GOBBONET = r'''#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    "setup --status") exit 1 ;;
    "config get") printf '\n'; exit 0 ;;
esac
echo "fake gobbonet: unexpected: $*" >&2
exit 3
'''

# The setup page: says where it is, writes its pid, then waits or fails.
FAKE_SETUP = r'''import os, sys, time
open(os.environ['FAKE_PIDFILE'], 'w').write(str(os.getpid()))
if os.environ.get('FAKE_SETUP') == 'quiet':
    time.sleep(60)
print('GobboNet setup is at: http://127.0.0.1:47123/', flush=True)
if os.environ.get('FAKE_SETUP') == 'fail':
    print('stand-in setup: the password could not be saved', flush=True)
    sys.exit(1)
time.sleep(60)
'''

# Dialogs would need a display; these answer at once.
QUIET = '#!/bin/sh\nexit 0\n'


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie is gone for this purpose.
    try:
        return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ')[1][0] != 'Z'
    except (OSError, IndexError):
        return False


def first_run(setup_mode, sig=None, wait_for='browser', launcher=LAUNCH):
    """Run a first run; stop it with sig (None: let it end by itself).
    Returns (setup files left, launch.log text, launcher exit code, setup page still running)."""
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        prefix = t / 'lib'
        prefix.mkdir()
        shutil.copy(launcher, prefix / 'gobbonet-launch')
        (prefix / 'gobbonet').write_text(FAKE_GOBBONET)
        (prefix / 'gobbonet-setup.py').write_text(FAKE_SETUP)
        for f in ('gobbonet-launch', 'gobbonet'):
            (prefix / f).chmod(0o755)
        fakebin = t / 'bin'
        fakebin.mkdir()
        browser = t / 'browser.log'
        (fakebin / 'xdg-open').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$BROWSER_LOG"\n')
        for name in ('zenity', 'kdialog', 'notify-send'):
            (fakebin / name).write_text(QUIET)
        for f in fakebin.iterdir():
            f.chmod(0o755)
        data = t / 'data'
        pidfile = t / 'setup.pid'
        env = dict(os.environ, PATH=f'{fakebin}:{os.environ["PATH"]}', BROWSER_LOG=str(browser),
                   DISPLAY=':99', XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(t / 'config'),
                   FAKE_SETUP=setup_mode, FAKE_PIDFILE=str(pidfile))
        env.pop('WAYLAND_DISPLAY', None)
        p = subprocess.Popen([str(prefix / 'gobbonet-launch')], env=env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        folder = data / 'gobbonet'
        setup_pid = None
        try:
            for _ in range(150):
                if pidfile.exists() and pidfile.read_text():
                    setup_pid = int(pidfile.read_text())
                if p.poll() is not None:
                    break
                if wait_for == 'browser' and browser.exists():
                    break
                if wait_for == 'setup' and setup_pid:
                    break
                time.sleep(0.1)
            if sig is not None:
                time.sleep(0.3)
                p.send_signal(sig)        # the launcher only, as a logout or kill reaches it first
            code = p.wait(timeout=20)
            time.sleep(0.3)
            running = bool(setup_pid) and alive(setup_pid)
            left = sorted(f.name for f in folder.glob('setup.*')) if folder.exists() else []
            log = (folder / 'launch.log').read_text() if (folder / 'launch.log').exists() else ''
        finally:
            if setup_pid and alive(setup_pid):
                os.kill(setup_pid, signal.SIGKILL)
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return left, log, code, running


print('\n=== A. the Linux launcher ===')
if shutil.which('python3') is None:
    print('  SKIP  no python3 for the stand-in setup page')
else:
    for sig, name in ((signal.SIGTERM, 'SIGTERM'), (signal.SIGHUP, 'SIGHUP (a logout)'), (signal.SIGINT, 'SIGINT (Ctrl+C)')):
        left, log, code, running = first_run('wait', sig)
        ok(left == [], f'stopped by {name} with the wizard open: no setup log is left', left)
        ok('GobboNet setup is at: http://127.0.0.1:47123/' in log, '  and what the setup page printed is in launch.log', log[-300:])
        ok(not running, '  and the setup page was stopped with it')
        ok(code == 130, f'  and the launcher exits 130 (got {code})')

    # Before the page has said where it is: the trap used to be set only after
    # the browser step, so this left the file and an orphaned setup page.
    left, log, code, running = first_run('quiet', signal.SIGTERM, wait_for='setup')
    ok(left == [] and not running, 'stopped before the page said where it is: no setup log, no setup page left',
       (left, running))

    left, log, code, running = first_run('fail')
    ok(left == [], 'a setup that fails: no setup log is left', left)
    ok('stand-in setup: the password could not be saved' in log and "GobboNet's first-run setup did not finish." in log,
       "  and its last words are in launch.log, with the launcher's", log[-400:])
    ok(code == 1, f'  and the launcher exits 1 (got {code})')

print('\n=== B. the script itself ===')
text = LAUNCH.read_text()
ok((ROOT / 'linux-amd64' / 'gobbonet-launch').read_text() == text, 'the ZIP copy of the launcher is identical')
start = text.index('SETUP_PID=$!')
trap = text.index("trap 'kill \"$SETUP_PID\" 2>/dev/null; end_setup_log; exit 130' INT TERM HUP")
browser = text.index('if [ -n "$WIZARD" ] && [ "$OPEN_BROWSER" = "1" ]; then')
ok(start < trap < browser, 'the trap is set as soon as the setup page starts, before the browser step')
done = text[text.index('if ! wait "$SETUP_PID"; then'):]
done = done[:done.index('\nfi\n')]
ok(done.count('end_setup_log') == 2 and 'trap - INT TERM HUP' in done,
   'a finished setup still puts the page log in launch.log and removes it, then drops the trap')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
