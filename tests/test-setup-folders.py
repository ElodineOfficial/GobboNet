#!/usr/bin/env python3
"""The Linux setup asks for a data folder and a models folder (1.8.0, issue #68).

It used to ask for one "Data and model folder" and always store
model_dir = <folder>/models, so someone who pointed it at the folder their
models were already in got an empty models subfolder, and the wizard said
nothing about the models it had walked past.

This runs installer-linux/gobbonet-setup.py for real, beside a freshly built
gobbonet (or GOBBONET_TEST_BIN), against throwaway HOME and XDG folders, and
checks what it stores in config.toml:

  * /api/scan counts the models in a typed folder, top level and one down,
    the way the model menu counts them (any-case .gguf, first split part only,
    no vision projector, no hidden folders), and answers only on 127.0.0.1;
  * /api/location {data, models} stores model_dir exactly as chosen, write-
    tests both folders without touching what is in them, and adds a folder
    whose models are one level down to model_dirs -- and takes that back if
    the user changes their mind;
  * the old {path} form still means <path>/models;
  * the finish step's "Download a model" guard accepts such a collection.

tests/test-linux-installer.py checks the page's side of it.
See docs/changelog/CHANGELOG-1.8.0-setup-folders.md.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
passed = failed = 0


def check(cond, what):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS ', what)
    else:
        failed += 1
        print('  FAIL ', what)


def gguf(path, size=4096):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'GGUF' + b'\0' * (size - 4))


def build_binary(tmp):
    given = os.environ.get('GOBBONET_TEST_BIN')
    if given:
        return Path(given)
    if not shutil.which('go'):
        return None
    out = tmp / 'gobbonet'
    p = subprocess.run(['go', 'build', '-o', str(out), './cmd/gobbonet'], cwd=ROOT,
                       capture_output=True, text=True)
    if p.returncode:
        print(p.stderr)
        raise SystemExit('could not build gobbonet for this test')
    return out


def main():
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        binary = build_binary(tmp)
        if binary is None:
            print('  SKIP  no Go toolchain and no GOBBONET_TEST_BIN: nothing to run the setup beside')
            return 0
        prefix = tmp / 'prefix'
        prefix.mkdir()
        for name in ('gobbonet-setup.py', 'wizard.html'):
            shutil.copy(ROOT / 'installer-linux' / name, prefix / name)
        shutil.copy(ROOT / 'catalog' / 'models.ini', prefix / 'models.ini')
        shutil.copy(binary, prefix / 'gobbonet')
        home = tmp / 'home'
        home.mkdir()
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(tmp / 'config'),
                   XDG_DATA_HOME=str(tmp / 'data'), NO_PROXY='*', no_proxy='*')
        env.pop('GOBBONET_CONFIG', None)

        def gn(*args):
            return subprocess.run([str(prefix / 'gobbonet'), *args], env=env, capture_output=True,
                                  text=True, check=True).stdout.strip()

        # A model collection: what the menu would list, and what it would not.
        coll = home / 'My Models'
        for name in ('a.gguf', 'B.GGUF', 'split-00001-of-00002.gguf'):
            gguf(coll / name)
        for name in ('split-00002-of-00002.gguf', 'mmproj-a.gguf'):
            gguf(coll / name)
        (coll / 'notes.txt').write_text('mine')
        gguf(coll / 'by-maker' / 'c.gguf')
        gguf(coll / '.hidden' / 'd.gguf')
        sub_only = home / 'Sorted'
        gguf(sub_only / 'maker' / 'e.gguf')

        # The engine is only named here, never run: setup offers "On this
        # machine" when it has one, and the finish step is what is tested.
        engine = tmp / 'llama-server'
        engine.write_text('#!/bin/sh\necho "version: 0 (test stand-in)"\n')
        engine.chmod(0o755)
        server = subprocess.Popen([sys.executable, '-B', str(prefix / 'gobbonet-setup.py'), str(engine)],
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = server.stdout.readline()
            if 'http://127.0.0.1:' not in line:
                print(server.stderr.read())
                raise SystemExit('the setup server did not start: ' + line)
            url = line.split('at: ', 1)[1].strip().rstrip('/')

            def get(path, host=None):
                req = urllib.request.Request(url + path)
                if host:
                    req.add_header('Host', host)
                try:
                    with HTTP.open(req, timeout=30) as r:
                        return r.status, json.load(r)
                except urllib.error.HTTPError as e:
                    return e.code, json.load(e)

            def post(path, body):
                req = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                                             headers={'Content-Type': 'application/json', 'Origin': url})
                try:
                    with HTTP.open(req, timeout=60) as r:
                        return r.status, json.load(r)
                except urllib.error.HTTPError as e:
                    return e.code, json.load(e)

            def scan(path):
                return get('/api/scan?path=' + urllib.parse.quote(str(path)))

            print('/api/scan')
            code, r = scan(coll)
            check(code == 200 and r == {'absolute': True, 'exists': True, 'models': 3, 'models_sub': 1},
                  'counts a collection the way the model menu does: %s' % r)
            code, r = scan(sub_only)
            check(r.get('models') == 0 and r.get('models_sub') == 1, 'counts models one folder down: %s' % r)
            code, r = scan('relative/folder')
            check(code == 200 and r.get('absolute') is False, 'a relative path is not a folder to use')
            code, r = scan(home / 'not-there')
            check(r.get('exists') is False and r.get('absolute') is True, 'a folder that is not there yet')
            code, r = scan('~/My Models')
            check(r.get('models') == 3, '~ means the home folder')
            code, _ = get('/api/scan?path=' + urllib.parse.quote(str(coll)), host='evil.example')
            check(code == 403, 'answers only the page on 127.0.0.1 (403 for another Host)')

            print('/api/location {data, models}')
            data = home / 'GobboNet'
            code, r = post('/api/location', {'data': str(data), 'models': str(coll)})
            check(code == 200 and r.get('model_dir') == str(coll), 'saved: %s %s' % (code, r))
            check(r.get('models_found') == 3 and r.get('models_in_subfolders') == 1,
                  'reports what it found for the page to show')
            check(gn('config', 'get', 'model_dir') == str(coll), 'model_dir is the folder chosen, no /models added')
            check(gn('config', 'get', 'data_dir') == str(data), 'data_dir is the data folder')
            check(json.loads(gn('config', 'get', '--json', 'model_dirs')) == [str(coll)],
                  'models one folder down: the folder joins model_dirs, space and all')
            check((coll / 'notes.txt').read_text() == 'mine' and not list(coll.glob('.gobbonet-write-test*'))
                  and not (coll / 'models').exists(),
                  'the write test leaves the collection as it was, and adds no models subfolder')
            check(data.is_dir() and (data.stat().st_mode & 0o777) == 0o700, 'a new data folder is created 0700')

            code, r = get('/api/state')
            check(code == 200 and r.get('model_dir') == str(coll) and r.get('models_found') == 3,
                  '/api/state carries the models count the model step mentions')

            empty = home / 'Empty Models'
            code, r = post('/api/location', {'data': str(data), 'models': str(empty)})
            check(code == 200 and r.get('models_found') == 0, 'a new, empty models folder')
            check(empty.is_dir() and (empty.stat().st_mode & 0o777) == 0o700, 'a new models folder is created 0700')
            check(json.loads(gn('config', 'get', '--json', 'model_dirs')) == [],
                  'changing the models folder takes back the model_dirs entry setup added')

            gn('config', 'set', 'model_dirs', json.dumps(['/srv/shared models']))
            code, r = post('/api/location', {'data': str(data), 'models': str(sub_only)})
            check(json.loads(gn('config', 'get', '--json', 'model_dirs')) == ['/srv/shared models', str(sub_only)],
                  'keeps model_dirs the user already had, and adds beside them')
            code, r = post('/api/location', {'data': str(data), 'models': str(data)})
            check(code == 200 and gn('config', 'get', 'model_dir') == str(data), 'models in the data folder itself')
            check(json.loads(gn('config', 'get', '--json', 'model_dirs')) == ['/srv/shared models'],
                  "...and the user's own model_dirs entry is never taken back")

            print('/api/location, old form and refusals')
            old = home / 'Old Form'
            code, r = post('/api/location', {'path': str(old)})
            check(code == 200 and gn('config', 'get', 'model_dir') == str(old / 'models'),
                  '{path} alone still means <path>/models')
            code, r = post('/api/location', {'data': str(data), 'models': 'models'})
            check(code == 400 and 'models folder' in r.get('error', ''), 'a relative models folder is refused: %s' % r)
            code, r = post('/api/location', {'data': '', 'models': str(coll)})
            check(code == 400 and 'data folder' in r.get('error', ''), 'an empty data folder is refused')
            if os.geteuid() != 0:
                locked = home / 'locked'
                locked.mkdir(mode=0o500)
                code, r = post('/api/location', {'data': str(data), 'models': str(locked)})
                check(code == 400 and 'cannot write to the models folder' in r.get('error', ''),
                      'a models folder it cannot write to is refused, by name')
                locked.chmod(0o700)
            else:
                print('  SKIP  read-only folder (running as root, which can write anywhere)')

            print('/api/finish, the "Download a model" guard')
            code, r = post('/api/location', {'data': str(data), 'models': str(empty)})
            post('/api/password', {'password': 'test-only-password', 'confirm': 'test-only-password'})
            code, b = post('/api/backend', {'mode': 'local'})
            if code == 200:
                code, r = post('/api/finish', {'lan': False})
                check(code == 400 and r.get('error', '').startswith('Download a model'),
                      'an empty models folder still stops the finish')
                post('/api/location', {'data': str(data), 'models': str(sub_only)})
                post('/api/backend', {'mode': 'local'})
                code, r = post('/api/finish', {'lan': False})
                check(not r.get('error', '').startswith('Download a model'),
                      'a collection one folder down gets past it (%s %s)' % (code, r.get('error', 'ok')))
            else:
                print('  SKIP  this build refused a local backend (%s): %s' % (code, b))
        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
    print('\n%d passed, %d failed' % (passed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
