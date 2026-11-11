#!/usr/bin/env python3
"""Start at login, ticked in the AppImage's setup, starts the AppImage (1.8.0).

The setup page wrote the launcher beside it into the login entry. From an
AppImage that launcher is inside the image's temporary mount (/tmp/.mount_...),
gone once GobboNet closes, so the entry did nothing at the next login (1.7.8 to
1.8.0). Found by running the 1.8.0 AppImage as a user. Both writers of the
entry now name the AppImage file itself when they run from one: the setup page
(installer-linux/gobbonet-setup.py) and `gobbonet setup` underneath it
(internal/autostart, tested in Go too).

This runs gobbonet-setup.py for real, beside a freshly built gobbonet (or
GOBBONET_TEST_BIN), against throwaway HOME and XDG folders, through to Finish
with Start at login ticked, and reads the entry it leaves:

  A. laid out as an AppImage's mount, with APPIMAGE and APPDIR set as the
     runtime sets them, and a space in the AppImage's path: the entry starts
     the AppImage, quoted, with --no-browser;
  B. a package or ZIP layout: the launcher beside the setup page, as before;
  C. APPIMAGE and APPDIR left by some other AppImage that started this one:
     not mistaken for GobboNet's.

Run: python3 tests/test-appimage-login-entry.py
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
passed = failed = 0


def check(cond, what, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS ', what)
    else:
        failed += 1
        print('  FAIL ', what + (('\n        ' + str(extra)[:600]) if extra else ''))


def build_binary(tmp):
    given = os.environ.get('GOBBONET_TEST_BIN')
    if given:
        return Path(given)
    if not shutil.which('go'):
        return None
    out = tmp / 'gobbonet'
    p = subprocess.run(['go', 'build', '-o', str(out), './cmd/gobbonet'], cwd=ROOT, capture_output=True, text=True)
    if p.returncode:
        print(p.stderr)
        raise SystemExit('could not build gobbonet for this test')
    return out


def freeport():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def first_run(tmp, binary, prefix, extra_env):
    """Finish setup with Start at login ticked; return the entry's Exec line."""
    prefix.mkdir(parents=True)
    for name in ('gobbonet-setup.py', 'wizard.html'):
        shutil.copy(ROOT / 'installer-linux' / name, prefix / name)
    shutil.copy(ROOT / 'catalog' / 'models.ini', prefix / 'models.ini')
    shutil.copy(binary, prefix / 'gobbonet')
    home = tmp / 'home'
    home.mkdir()
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(tmp / 'config'),
               XDG_DATA_HOME=str(tmp / 'data'), NO_PROXY='*', no_proxy='*')
    for k in ('GOBBONET_CONFIG', 'APPIMAGE', 'APPDIR'):
        env.pop(k, None)
    env.update(extra_env)
    engine = tmp / 'llama-server'
    engine.write_text('#!/bin/sh\necho "version: 0 (test stand-in)"\n')
    engine.chmod(0o755)
    server = subprocess.Popen([sys.executable, '-B', str(prefix / 'gobbonet-setup.py'), str(engine)],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = server.stdout.readline()
        if 'http://127.0.0.1:' not in line:
            raise SystemExit('the setup server did not start: ' + line + server.stderr.read())
        url = line.split('at: ', 1)[1].strip().rstrip('/')

        def post(path, body):
            req = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json', 'Origin': url})
            try:
                with HTTP.open(req, timeout=60) as r:
                    return r.status, json.load(r)
            except urllib.error.HTTPError as e:
                return e.code, json.load(e)

        steps = [('/api/location', {'data': str(tmp / 'data' / 'gobbonet')}),
                 ('/api/password', {'password': 'test-only-password', 'confirm': 'test-only-password'}),
                 ('/api/port', {'port': freeport()}),
                 ('/api/backend', {'mode': 'remote', 'url': 'http://127.0.0.1:1', 'key': ''}),
                 ('/api/finish', {'lan': False, 'autostart': True})]
        for path, body in steps:
            code, reply = post(path, body)
            if code != 200:
                raise SystemExit(f'{path} answered {code}: {reply}')
    finally:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
    entry = tmp / 'config' / 'autostart' / 'gobbonet.desktop'
    text = entry.read_text() if entry.exists() else ''
    return next((l for l in text.splitlines() if l.startswith('Exec=')), '(no entry)')


def main():
    with tempfile.TemporaryDirectory() as t:
        binary = build_binary(Path(t))
        if binary is None:
            print('  SKIP  no Go toolchain and no GOBBONET_TEST_BIN')
            return 0

        print('\n=== A. from an AppImage ===')
        tmp = Path(t) / 'a'
        mount = tmp / '.mount_GobboX'
        image = tmp / 'My Apps' / 'GobboNet 1.8.AppImage'
        exec_line = first_run(tmp, binary, mount / 'usr' / 'lib' / 'gobbonet',
                              {'APPDIR': str(mount), 'APPIMAGE': str(image)})
        check(exec_line == f'Exec="{image}" --no-browser',
              'the login entry starts the AppImage file, quoted, with --no-browser', exec_line)
        check(str(mount) not in exec_line, 'and names nothing inside the temporary mount', exec_line)

        print('\n=== B. a package or ZIP layout ===')
        tmp = Path(t) / 'b'
        prefix = tmp / 'GobboNet' / 'linux-amd64'
        exec_line = first_run(tmp, binary, prefix, {})
        check(exec_line == f'Exec="{prefix / "gobbonet-launch"}" --no-browser',
              'the login entry starts the launcher beside the setup page, as before', exec_line)

        print("\n=== C. another AppImage's variables ===")
        tmp = Path(t) / 'c'
        prefix = tmp / 'GobboNet' / 'linux-amd64'
        exec_line = first_run(tmp, binary, prefix, {'APPDIR': str(tmp / '.mount_Term'),
                                                     'APPIMAGE': str(tmp / 'Terminal.AppImage')})
        check(exec_line == f'Exec="{prefix / "gobbonet-launch"}" --no-browser',
              'APPIMAGE from an AppImage that started this one is not taken for GobboNet', exec_line)

    print(f'\n{passed} passed, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
