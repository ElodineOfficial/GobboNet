#!/usr/bin/env python3
"""The setup page's Install location step says where THIS install's program
files are (1.8.1).

wizard.html opens that step with "The Debian package manages program files in
/usr/lib/gobbonet." -- true of the .deb. The .rpm's build rewrites the line for
its own path (installer-fedora/gobbonet.spec), but the AppImage and the ZIP run
the same page unchanged, so since 1.7.9 they told their users about a Debian
package they did not have. gobbonet-setup.py now puts their own sentence in
when it serves the page: the AppImage file for the AppImage, the folder it was
unpacked into for the ZIP. A package's page is served as it is.

  A. install_kind() and the sentence, for every layout, from the module itself;
     a path that looks like markup is escaped; a package's page is untouched.
  B. The sentence setup replaces is in both copies of wizard.html exactly once,
     and is the one the .rpm's sed rewrites, so none of the three can drift
     from the others without this failing.
  C. The real setup server, laid out as an AppImage's mount and as an unpacked
     ZIP: GET / and /api/state. Needs a gobbonet binary (built here with go,
     or GOBBONET_TEST_BIN), as tests/test-appimage-login-entry.py does.

Run: python3 tests/test-setup-program-files.py
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

sys.dont_write_bytecode = True
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


def load():
    spec = importlib.util.spec_from_file_location('gobbonet_setup_pf', ROOT / 'installer-linux' / 'gobbonet-setup.py')
    mod = importlib.util.module_from_spec(spec)
    saved = sys.argv
    sys.argv = ['gobbonet-setup.py']
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved
    return mod


def with_env(env, fn):
    saved = {k: os.environ.get(k) for k in ('APPIMAGE', 'APPDIR')}
    for k in saved:
        os.environ.pop(k, None)
    os.environ.update(env)
    try:
        return fn()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def unit(t):
    print('\n=== A. which install, and what the page says ===')
    m = load()
    debian = m.DEBIAN_PROGRAM_FILES

    mount = (t / '.mount_GobboX').resolve()
    image = t / 'My Apps' / 'GobboNet-1.8.0-x86_64.AppImage'
    m.PREFIX = mount / 'usr' / 'lib' / 'gobbonet'
    kind = with_env({'APPDIR': str(mount), 'APPIMAGE': str(image)}, m.install_kind)
    sentence = with_env({'APPDIR': str(mount), 'APPIMAGE': str(image)}, m.program_files_sentence)
    check(kind == ('appimage', str(image)), 'from an AppImage: the AppImage file', kind)
    check(sentence and str(image) in sentence and 'Debian' not in sentence and 'inside the AppImage' in sentence,
          'and the sentence names it, not a Debian package', sentence)

    m.PREFIX = (t / 'GobboNet' / 'linux-amd64').resolve()
    check(with_env({}, m.install_kind) == ('zip', str(m.PREFIX.parent)), 'an unpacked ZIP: the folder it was unpacked into')
    s = with_env({}, m.program_files_sentence)
    check(s and str(m.PREFIX.parent) in s and 'folder you unpacked' in s and 'Debian' not in s, 'and says so', s)
    other = {'APPDIR': str(t / '.mount_Term'), 'APPIMAGE': str(t / 'Terminal.AppImage')}
    check(with_env(other, m.install_kind)[0] == 'zip', "another AppImage's variables are not taken for GobboNet's")

    for prefix, what in ((Path('/usr/lib/gobbonet'), 'the .deb'), (Path('/usr/lib64/gobbonet'), 'the .rpm')):
        m.PREFIX = prefix
        check(with_env({}, m.install_kind) == ('package', str(prefix)) and with_env({}, m.program_files_sentence) is None,
              f'{what} ({prefix}): a package, whose page is already right')

    # The page itself, served from a folder: escaped, replaced once, nothing else touched.
    odd = (t / 'a <b> & "c"' / 'linux-amd64')
    odd.mkdir(parents=True)
    shutil.copy(ROOT / 'installer-linux' / 'wizard.html', odd / 'wizard.html')
    m.PREFIX = odd.resolve()
    page = with_env({}, m.wizard_page).decode('utf-8')
    original = (odd / 'wizard.html').read_text(encoding='utf-8')
    check(debian not in page, 'the ZIP is served without the Debian sentence')
    check('a &lt;b&gt; &amp; "c"' in page and '<b>' not in page.split('id="location"', 1)[1][:600],
          'a folder name that looks like markup is shown as text')
    import html as _html
    shown = _html.escape(with_env({}, m.program_files_sentence), quote=False)
    check(page.count(shown) == 1 and page.replace(shown, debian) == original,
          'and nothing else on the page changes')
    m.PACKAGE_PREFIXES = (odd.resolve(),)
    check(with_env({}, m.wizard_page) == (odd / 'wizard.html').read_bytes(), "a package's page is served byte for byte")


def sources():
    print('\n=== B. the sentence, the page and the .rpm agree ===')
    m = load()
    for rel in ('installer-linux/wizard.html', 'linux-amd64/wizard.html'):
        n = (ROOT / rel).read_text(encoding='utf-8').count(m.DEBIAN_PROGRAM_FILES)
        check(n == 1, f'{rel} has the sentence setup replaces, once', n)
    spec = (ROOT / 'installer-fedora' / 'gobbonet.spec').read_text()
    check('s|' + m.DEBIAN_PROGRAM_FILES.replace('.', '\\.') + '|' in spec or
          's|' + m.DEBIAN_PROGRAM_FILES[:-1].replace('.', '\\.') + '\\.|' in spec,
          "and the .rpm's sed rewrites that same sentence")
    a = (ROOT / 'installer-linux' / 'gobbonet-setup.py').read_bytes()
    b = (ROOT / 'linux-amd64' / 'gobbonet-setup.py').read_bytes()
    check(a == b, "the ZIP's gobbonet-setup.py is the same file")


def binary(t):
    given = os.environ.get('GOBBONET_TEST_BIN')
    if given:
        return Path(given)
    if not shutil.which('go'):
        return None
    out = t / 'gobbonet'
    p = subprocess.run(['go', 'build', '-o', str(out), './cmd/gobbonet'], cwd=ROOT, capture_output=True, text=True)
    if p.returncode:
        raise SystemExit('could not build gobbonet for this test:\n' + p.stderr)
    return out


def served(t, gobbonet, prefix, env_extra):
    prefix.mkdir(parents=True)
    for name in ('gobbonet-setup.py', 'wizard.html'):
        shutil.copy(ROOT / 'installer-linux' / name, prefix / name)
    shutil.copy(ROOT / 'catalog' / 'models.ini', prefix / 'models.ini')
    shutil.copy(gobbonet, prefix / 'gobbonet')
    engine = t / 'llama-server'
    engine.write_text('#!/bin/sh\necho "version: 0 (test stand-in)"\n')
    engine.chmod(0o755)
    env = dict(os.environ, HOME=str(t / 'home'), XDG_CONFIG_HOME=str(t / 'config'), XDG_DATA_HOME=str(t / 'data'),
               NO_PROXY='*', no_proxy='*')
    for k in ('GOBBONET_CONFIG', 'APPIMAGE', 'APPDIR'):
        env.pop(k, None)
    env.update(env_extra)
    srv = subprocess.Popen([sys.executable, '-B', str(prefix / 'gobbonet-setup.py'), str(engine)], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = srv.stdout.readline()
        if 'http://127.0.0.1:' not in line:
            raise SystemExit('the setup server did not start: ' + line + srv.stderr.read())
        url = line.split('at: ', 1)[1].strip().rstrip('/')
        page = HTTP.open(url + '/', timeout=30).read().decode('utf-8')
        state = json.load(HTTP.open(url + '/api/state', timeout=60))
        return page, state
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=15)
        except subprocess.TimeoutExpired:
            srv.kill()


def live(t):
    print('\n=== C. the real setup page ===')
    gobbonet = binary(t)
    if gobbonet is None:
        print('  SKIP  no Go toolchain and no GOBBONET_TEST_BIN')
        return
    a = t / 'appimage'
    mount = a / '.mount_GobboX'
    image = a / 'My Apps' / 'GobboNet-1.8.0-x86_64.AppImage'
    page, state = served(a, gobbonet, mount / 'usr' / 'lib' / 'gobbonet', {'APPDIR': str(mount), 'APPIMAGE': str(image)})
    step = page.split('id="location"', 1)[1][:700]
    check('Debian' not in step and f"inside the AppImage, {image}" in step, 'AppImage: the step names the AppImage file', step[:300])
    check(state.get('install_kind') == 'appimage' and state.get('program_files') == str(image),
          '/api/state says appimage, and where', {k: state.get(k) for k in ('install_kind', 'program_files')})
    z = t / 'zip'
    prefix = z / 'GobboNet' / 'linux-amd64'
    page, state = served(z, gobbonet, prefix, {})
    step = page.split('id="location"', 1)[1][:700]
    folder = str(prefix.resolve().parent)
    check('Debian' not in step and f'the folder you unpacked, {folder}' in step, 'ZIP: the step names the unpacked folder', step[:300])
    check(state.get('install_kind') == 'zip' and state.get('program_files') == folder, '/api/state says zip, and where')


def main():
    with tempfile.TemporaryDirectory() as d:
        t = Path(d)
        unit(t / 'unit')
        sources()
        live(t / 'live')
    print(f'\n{passed} passed, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
