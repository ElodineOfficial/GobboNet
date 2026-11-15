#!/usr/bin/env python3
"""OpenSSL 3 for the engine, on a system without it (1.8.1).

llama.cpp's libllama-common.so and libllama-server-impl.so need libssl.so.3 and
libcrypto.so.3. Fedora 45 and later ship OpenSSL 4 and keep 3 as a separate
package, openssl3-libs. The .rpm depends on it; the AppImage and the ZIP cannot
install it, so there the 1.8.0 engine did not load ("libssl.so.3: cannot open
shared object file"), and the launcher blamed the GPU build. Both now carry the
two libraries, pinned in engine.sha256, in openssl3/, and gobbonet-launch puts
them on the library path only when the system's dynamic loader cannot find its
own (asked with LD_TRACE_LOADED_OBJECTS, ldd's own mechanism).

  A. The wiring, statically: the pin, the fetch script, make-zip.sh and
     build-appimage.sh require and check the files, the .deb and .rpm never
     carry them, the licence travels with them, both launchers are one file.
  B. The real launcher, run on this system (which has OpenSSL 3), then on a
     simulated system without it: in a private mount namespace the system's
     libssl.so.3 and libcrypto.so.3 are covered by an ELF header for another
     CPU, which the x86-64 loader skips, so they are "not found" as on Fedora
     45. Checked: 1.8.0's failure is reproduced; the launcher adds openssl3/ and
     only then; the engine then starts with every symbol bound (LD_BIND_NOW);
     a first run records openssl=bundled in engine-choice, says so in the log,
     and gobbonet doctor says so too; with no openssl3/ (a package) nothing
     changes. Needs linux-amd64/gobbonet, the engine in linux-amd64/llama-cpp
     and the libraries in linux-amd64/openssl3 (scripts/fetch-openssl3.sh);
     the simulation also needs `unshare` with permission to mount (root, or
     user namespaces). What cannot run here is SKIPPED and says so.

Run: python3 tests/test-openssl3.py
"""
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
AMD = ROOT / 'linux-amd64'
passed = failed = 0


def check(cond, what, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS ', what)
    else:
        failed += 1
        print('  FAIL ', what + (('\n        ' + str(extra)[:800]) if extra else ''))


def skip(what):
    print('  SKIP ', what)


def pins():
    out = subprocess.run(['bash', '-c', 'set -u; . ./engine.sha256; for v in OPENSSL3_DEB OPENSSL3_DEB_URL '
                          'OPENSSL3_DEB_SHA256 LIBSSL3_SHA256 LIBCRYPTO3_SHA256; do echo "$v=${!v}"; done'],
                         cwd=ROOT, capture_output=True, text=True)
    return dict(l.split('=', 1) for l in out.stdout.splitlines() if '=' in l), out.returncode


def static():
    print('\n=== A. the wiring ===')
    p, rc = pins()
    check(rc == 0 and all(re.fullmatch(r'[0-9a-f]{64}', p.get(k, '')) for k in
                          ('OPENSSL3_DEB_SHA256', 'LIBSSL3_SHA256', 'LIBCRYPTO3_SHA256')),
          'engine.sha256 pins the package and both libraries, and still sources as shell', p)
    check(p.get('OPENSSL3_DEB_URL', '').endswith('/' + p.get('OPENSSL3_DEB', '-')),
          'the URL is the pinned package file')
    fetch = (ROOT / 'scripts' / 'fetch-openssl3.sh').read_text()
    check(all(k in fetch for k in ('OPENSSL3_DEB_SHA256', 'LIBSSL3_SHA256', 'LIBCRYPTO3_SHA256')),
          'fetch-openssl3.sh checks the package and each library against the pin')
    lic = (ROOT / 'installer-linux' / 'openssl3-LICENSE.txt').read_text()
    check('Apache License' in lic and 'Version 2.0, January 2004' in lic and 'LICENSE.txt' in fetch,
          "OpenSSL's licence (Apache 2.0) goes beside the libraries")
    mz = (ROOT / 'scripts' / 'make-zip.sh').read_text()
    manifest = mz.split("MANIFEST='", 1)[1].split("'", 1)[0]
    check(all(f'linux-amd64/openssl3/{f}' in manifest for f in ('libssl.so.3', 'libcrypto.so.3', 'LICENSE.txt', 'SOURCE.txt')),
          "make-zip.sh's manifest requires them, in the full and the update archive alike")
    check('LIBSSL3_SHA256' in mz and 'LIBCRYPTO3_SHA256' in mz and 'not the pinned OpenSSL 3' in mz,
          'and refuses files that do not match the pin, or are not from it')
    ai = (ROOT / 'installer-linux' / 'build-appimage.sh').read_text()
    i_payload = ai.find('verify-payload.sh')
    i_fetch = ai.find('fetch-openssl3.sh" "$LIB/openssl3"')
    check(0 < i_payload < i_fetch, 'the AppImage adds them after holding the AppDir to the .deb payload list')
    payload = (ROOT / 'scripts' / 'payload.manifest').read_text()
    pay_lines = [l for l in payload.splitlines() if l.strip() and not l.lstrip().startswith('#')]
    check(not any('openssl3' in l for l in pay_lines), 'the .deb and .rpm payload list has no openssl3/: packages use the system\'s')
    for builder in ('installer-linux/build-deb.sh', 'installer-fedora/build-rpm.sh', 'installer-fedora/gobbonet.spec'):
        check('openssl3/' not in (ROOT / builder).read_text(), f'{builder} does not ship it')
    gi = (ROOT / '.gitignore').read_text()
    check('/linux-amd64/openssl3/' in gi, 'the fetched libraries are never committed')
    a, b = (ROOT / 'installer-linux' / 'gobbonet-launch').read_bytes(), (AMD / 'gobbonet-launch').read_bytes()
    check(a == b, "the ZIP's gobbonet-launch is the package's")
    launch = a.decode()
    head = launch.split('case "${1:-}" in', 1)[0]
    check('LD_TRACE_LOADED_OBJECTS=1' in head and '$PREFIX/openssl3' in head,
          'the launcher decides before any command runs, so doctor and serve see the same engine')
    check("printf 'openssl=%s\\n'" in launch, 'and records the decision in engine-choice')


def foreign_elf(path):
    """An ELF header for AArch64: the x86-64 loader skips it as another CPU's."""
    h = b'\x7fELF' + bytes([2, 1, 1, 0]) + bytes(8) + struct.pack('<HHIQQQIHHHHHH', 3, 183, 1, 0, 0, 0, 0, 64, 56, 0, 64, 0, 0)
    path.write_bytes(h + bytes(64))


def system_libs(engine, env):
    """Where this system's loader finds libssl.so.3 and libcrypto.so.3 for the engine."""
    out = subprocess.run([str(engine)], env=dict(env, LD_TRACE_LOADED_OBJECTS='1'), capture_output=True, text=True).stdout
    found = dict(re.findall(r'^\s*(lib(?:ssl|crypto)\.so\.3) => (/\S+)', out, re.M))
    return [os.path.realpath(v) for v in found.values()]


def without_openssl3(libs, cover, argv, env, timeout=60, popen=False):
    """argv, on this system as if it had no OpenSSL 3."""
    mounts = ' && '.join(f'mount --bind "$COVER" "{lib}"' for lib in libs)
    script = f'{mounts} || exit 99; exec "$@"'
    base = ['unshare', '-m'] if os.geteuid() == 0 else ['unshare', '-rm']
    full = base + ['bash', '-c', script, 'sim'] + [str(a) for a in argv]
    env = dict(env, COVER=str(cover))
    if popen:
        return subprocess.Popen(full, env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return subprocess.run(full, env=env, capture_output=True, text=True, timeout=timeout)


def prefix_copy(t, with_openssl3):
    """A launcher prefix of our own: the real launcher, the real engine, and a
    stand-in gobbonet that prints the library path it was given."""
    pre = t / ('zip' if with_openssl3 else 'package') / 'linux-amd64'
    pre.mkdir(parents=True)
    shutil.copy(AMD / 'gobbonet-launch', pre / 'gobbonet-launch')
    (pre / 'llama-cpp').symlink_to(AMD / 'llama-cpp')
    if with_openssl3:
        shutil.copytree(AMD / 'openssl3', pre / 'openssl3')
    (pre / 'gobbonet').write_text('#!/bin/sh\nprintf "LD_LIBRARY_PATH=%s\\n" "$LD_LIBRARY_PATH"\n')
    (pre / 'gobbonet').chmod(0o755)
    return pre


def first_run(t, prefix, sim_libs=None, cover=None):
    """Start the real launcher's first run until the setup page is up; return
    (engine-choice, launch output, doctor output)."""
    d = Path(tempfile.mkdtemp(dir=t))
    fake = d / 'bin'
    fake.mkdir()
    (fake / 'xdg-open').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$BROWSER_LOG"\n')
    (fake / 'xdg-open').chmod(0o755)
    env = dict(os.environ, XDG_CONFIG_HOME=str(d / 'config'), XDG_DATA_HOME=str(d / 'data'), DISPLAY=':99',
               PATH=str(fake) + ':' + os.environ['PATH'], BROWSER_LOG=str(d / 'browser.log'))
    env.pop('LD_LIBRARY_PATH', None)
    argv = [prefix / 'gobbonet-launch']
    p = without_openssl3(sim_libs, cover, argv, env, popen=True) if sim_libs else \
        subprocess.Popen([str(a) for a in argv], env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(150):
            if (d / 'browser.log').exists() or p.poll() is not None:
                break
            time.sleep(.1)
    finally:
        try:
            os.killpg(p.pid, 15)
        except ProcessLookupError:
            pass
        out = p.communicate(timeout=20)[0]
    choice = (d / 'data' / 'gobbonet' / 'engine-choice')
    choice = choice.read_text() if choice.exists() else ''
    log = d / 'data' / 'gobbonet' / 'launch.log'
    out += log.read_text() if log.exists() else ''
    # The run stopped on the setup page, before setup saved an engine, and doctor
    # reports no engine in remote mode: name the engine as finishing setup would.
    engine = next((e for e in (prefix / 'llama-cpp' / 'llama-server',) if e.exists()), None)
    subprocess.run([str(prefix / 'gobbonet'), 'config', 'set', 'server_exe', str(engine)], env=env,
                   capture_output=True, text=True, timeout=30)
    dargv = [prefix / 'gobbonet-launch', 'doctor']
    doc = (without_openssl3(sim_libs, cover, dargv, env) if sim_libs else
           subprocess.run([str(a) for a in dargv], env=env, capture_output=True, text=True, timeout=60))
    return choice, out, doc.stdout + doc.stderr


def live():
    print('\n=== B. the real launcher, with and without the system\'s OpenSSL 3 ===')
    engine = AMD / 'llama-cpp' / 'llama-server'
    p, _ = pins()
    if not (AMD / 'gobbonet').exists() or not engine.exists():
        skip('needs linux-amd64/gobbonet and the engine in linux-amd64/llama-cpp (bash ./scripts/make-zip.sh)')
        return
    if not all((AMD / 'openssl3' / f).exists() for f in ('libssl.so.3', 'libcrypto.so.3')):
        skip('needs linux-amd64/openssl3 (bash ./scripts/fetch-openssl3.sh linux-amd64/openssl3)')
        return
    env = dict(os.environ, LD_LIBRARY_PATH=str(AMD / 'llama-cpp'))
    libs = system_libs(engine, env)
    with tempfile.TemporaryDirectory(dir=ROOT) as td:
        t = Path(td)
        z, pkg = prefix_copy(t, True), prefix_copy(t, False)

        # On this system, which has OpenSSL 3: the bundle stays out of it.
        out = subprocess.run([str(z / 'gobbonet-launch'), 'probe'], env=dict(os.environ), capture_output=True, text=True).stdout
        if len(libs) == 2:
            check('openssl3' not in out, 'with the system\'s OpenSSL 3: the launcher leaves openssl3/ off the library path', out)
        else:
            skip('this system has no OpenSSL 3 of its own, so the "system wins" case cannot run')

        cover = t / 'not-this-cpu.elf'
        foreign_elf(cover)
        if len(libs) != 2:
            return
        probe = without_openssl3(libs, cover, [engine, '--version'], env)
        if probe.returncode == 99 or 'unshare' in probe.stderr and 'Operation not permitted' in probe.stderr:
            skip('cannot make a private mount namespace here (needs root, or user namespaces): ' + probe.stderr.strip()[:200])
            return
        check(probe.returncode != 0 and 'libssl.so.3: cannot open shared object file' in probe.stderr,
              "simulated Fedora 45: 1.8.0's failure, reproduced -- the engine alone does not load", probe.stderr)

        out = without_openssl3(libs, cover, [z / 'gobbonet-launch', 'probe'], dict(os.environ)).stdout
        check(f'{z}/openssl3' in out, 'the ZIP/AppImage launcher puts openssl3/ on the library path', out)
        out = without_openssl3(libs, cover, [pkg / 'gobbonet-launch', 'probe'], dict(os.environ)).stdout
        check('openssl3' not in out, 'a package (no openssl3/) is left as it was', out)
        ldp = str(AMD / 'llama-cpp') + ':' + str(AMD / 'openssl3')
        run = without_openssl3(libs, cover, [engine, '--version'], dict(env, LD_LIBRARY_PATH=ldp, LD_BIND_NOW='1'))
        check(run.returncode == 0 and 'build 10456' in (run.stdout + run.stderr),
              'with them the engine starts, every symbol bound at once (LD_BIND_NOW)', run.stderr[-300:])
        # Through env, so only the engine is traced, not unshare and bash on the way.
        trace = without_openssl3(libs, cover, ['env', 'LD_TRACE_LOADED_OBJECTS=1', engine], dict(env, LD_LIBRARY_PATH=ldp)).stdout
        check(f'libssl.so.3 => {AMD}/openssl3/libssl.so.3' in trace and f'libcrypto.so.3 => {AMD}/openssl3/libcrypto.so.3' in trace,
              'and both libraries are the bundled ones', trace)

    # The real thing: the launcher's first run, from the repo's linux-amd64.
    with tempfile.TemporaryDirectory(dir=ROOT) as td:
        t = Path(td)
        cover = t / 'not-this-cpu.elf'
        foreign_elf(cover)
        choice, out, doc = first_run(t, AMD, libs, cover)
        check('build=gpu' in choice and 'openssl=bundled' in choice,
              'a first run there: the GPU build starts, and engine-choice says openssl=bundled', choice)
        check("this system has no OpenSSL 3, so the engine uses GobboNet's own" in out, 'the launch log says so', out[-600:])
        check("openssl:      GobboNet's own OpenSSL 3" in doc and 'could not list them' not in doc,
              'gobbonet doctor says so, and its engine probe runs', doc[-900:])
        choice, out, doc = first_run(t, AMD)
        check('openssl=system' in choice and 'openssl:' not in doc,
              "the same first run with the system's OpenSSL 3: openssl=system, and doctor says nothing of it", choice)


def main():
    static()
    live()
    print(f'\n{passed} passed, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
