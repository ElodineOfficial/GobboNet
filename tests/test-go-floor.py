#!/usr/bin/env python3
"""Releases are not built with an older Go than the release before.

1.7.8 was built with go1.25.14. The first 1.7.9 builds used go1.25.0, the
toolchain the build machine had, and nothing said so. scripts/go-floor.sh now
refuses it, and both builders call it before building. Run here with stand-in
`go` commands. See docs/changelog/CHANGELOG-1.7.9-fedora-installer.md.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FLOOR = ROOT / 'scripts' / 'go-floor.sh'
passed = failed = 0


def check(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ok   ' + label)
    else:
        failed += 1
        print('  FAIL ' + label + (('\n       ' + str(extra)[:400]) if extra else ''))


def run(goversion):
    with tempfile.TemporaryDirectory() as tmp:
        go = Path(tmp) / 'go'
        go.write_text('#!/bin/sh\n[ "$1 $2" = "env GOVERSION" ] && { %s; exit 0; }\nexit 2\n'
                      % ('echo "%s"' % goversion if goversion is not None else 'exit 1'))
        go.chmod(0o755)
        return subprocess.run(['bash', str(FLOOR), str(go)], capture_output=True, text=True, timeout=20)


r = run('go1.25.0')
check('go1.25.0 is refused (the toolchain the first 1.7.9 builds used)', r.returncode != 0 and 'older than go1.25.14' in r.stderr, r.stderr)
check('and the message says how to get the right one', 'github.com/golang/go' in r.stderr and 'GO=' in r.stderr)
for v in ('go1.25.13', 'go1.24.99'):
    r = run(v)
    check(v + ' is refused', r.returncode != 0, r.stdout)
for v in ('go1.25.14', 'go1.25.15', 'go1.26.0', 'go1.27.3', 'go1.26rc1', 'go1.27.0 X:nocoverageredesign'):
    r = run(v)
    check(v + ' passes', r.returncode == 0 and 'floor go1.25.14' in r.stdout, (r.stdout, r.stderr))
r = run(None)
check('a go that cannot say its version is refused', r.returncode != 0, r.stdout)

for name in ('make-zip.sh', 'build-release.sh'):
    s = (ROOT / 'scripts' / name).read_text()
    at = s.find('bash ./scripts/go-floor.sh "$GO"')
    first_build = min(i for i in (s.find('build_one '), s.find('"$GO" build'), s.find('$GO build')) if i > 0)
    check(name + ' checks the floor before it builds anything', 0 < at < first_build)

print('\n%d passed, %d failed' % (passed, failed))
raise SystemExit(1 if failed else 0)
