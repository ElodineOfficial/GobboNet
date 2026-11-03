#!/usr/bin/env python3
"""The .deb built from a tree with no git names the build of the binary inside.

build-deb.sh used to stamp a no-git package with today's UTC date, while
make-zip.sh stamps the binary with the local date. Built in the evening in
America/Chicago, 1.7.9's package said nogit.20261102 around a server that
says nogit.20261101. It now takes the build id from `gobbonet version`, as
build-rpm.sh already did. The logic is cut out of build-deb.sh and run with
stand-in binaries. See docs/changelog/CHANGELOG-1.7.9-linux-installer.md.
"""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT / 'installer-linux' / 'build-deb.sh').read_text()

passed = failed = 0


def check(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ok   ' + label)
    else:
        failed += 1
        print('  FAIL ' + label + (('\n       ' + str(extra)[:400]) if extra else ''))


start = SRC.find('if [ -z "$SHA" ]; then')
end = SRC.find('\n', SRC.find('DEB_VERSION="${RELEASE}+go.${SHA}-${DEB_REVISION}"', start)) + 1
block = SRC[start:end]
check('build-deb.sh takes the no-git build id from the binary', start > 0 and 'version 2>/dev/null' in block, block[:200])
check('after the binary is found, before anything uses the version',
      SRC.find('file "$GOBBONET_BIN" | grep -q') < start and SRC.find('$DEB_VERSION') >= end - 80)
check('a git checkout still names its commit', 'git rev-parse --short HEAD' in SRC and 'SHA="$SHA-dirty"' in SRC)


def stamp(bin_script, epoch=None):
    with tempfile.TemporaryDirectory() as tmp:
        b = Path(tmp) / 'gobbonet'
        b.write_text(bin_script)
        b.chmod(0o755)
        script = ('set -euo pipefail\nfail() { echo "ERROR: $*" >&2; exit 1; }\n'
                  'RELEASE=1.7.9\nROOT=%s\nSHA=""\nDEB_REVISION=1\nGOBBONET_BIN=%s\n%s\necho "$DEB_VERSION"\n'
                  % (tmp, b, block))
        env = dict(os.environ)
        if epoch is not None:
            env['SOURCE_DATE_EPOCH'] = str(epoch)
        return subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=20, env=env)


r = stamp('#!/bin/sh\necho "1.7.9-go-nogit.20261101 (go1.25.0 linux/amd64)"\n')
check('a zip binary built on the 1st gives 1.7.9+go.nogit.20261101-1, whatever the date now',
      r.returncode == 0 and r.stdout.strip() == '1.7.9+go.nogit.20261101-1', (r.stdout, r.stderr))

r = stamp('#!/bin/sh\necho "1.7.9-go-a1b2c3d (go1.25.0 linux/amd64)"\n')
check('a binary built from a commit gives that commit', r.stdout.strip() == '1.7.9+go.a1b2c3d-1', (r.stdout, r.stderr))

r = stamp('#!/bin/sh\nexit 1\n', epoch=1793500000)
check('a binary that cannot run here falls back to the date (SOURCE_DATE_EPOCH)',
      r.returncode == 0 and r.stdout.strip() == '1.7.9+go.nogit.20261101-1', (r.stdout, r.stderr))

r = stamp('#!/bin/sh\necho "1.7.8-go-nogit.20261020 (go1.25.0 linux/amd64)"\n')
check("a binary from another release is refused, not packaged under this one's name",
      r.returncode != 0 and 'VERSION says 1.7.9' in r.stderr, (r.stdout, r.stderr))

rpm = (ROOT / 'installer-fedora' / 'build-rpm.sh').read_text()
check('the same rule the rpm follows', 'BUILD_ID="${BIN_VERSION#"$RELEASE-go-"}"' in rpm)

print('\n%d passed, %d failed' % (passed, failed))
raise SystemExit(1 if failed else 0)
