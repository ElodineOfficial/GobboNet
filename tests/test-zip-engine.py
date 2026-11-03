#!/usr/bin/env python3
"""A full ZIP carries the Vulkan llama.cpp engine, never the CPU-only one.

gobbonet-launch treats linux-amd64/llama-cpp as the GPU engine. Upstream's
CPU-only Linux archive has the same files minus libggml-vulkan.so and starts
just as well, so a ZIP carrying it runs every model on the processor with
nothing to say so. A 1.7.9 test build went out that way. make-zip.sh now
refuses it, as build-deb.sh already did for the package.

The guard is cut out of make-zip.sh and run for real against fake engine
folders. See docs/changelog/CHANGELOG-1.7.9-linux-installer.md.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MZ = (ROOT / 'scripts' / 'make-zip.sh').read_text()
BUILD_DEB = (ROOT / 'installer-linux' / 'build-deb.sh').read_text()

passed = failed = 0


def check(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ok   ' + label)
    else:
        failed += 1
        print('  FAIL ' + label + (('\n       ' + str(extra)[:400]) if extra else ''))


start = MZ.find('# The engine in a full archive must be the pinned Vulkan build')
end = MZ.find('\nfi\n', MZ.find('libggml-vulkan.so', start)) + 4
guard = MZ[start:end]
check('make-zip.sh has the Vulkan guard', start > 0 and 'libggml-vulkan.so' in guard and guard.rstrip().endswith('fi'), guard[:200])
check('it runs before anything is built', 0 < start < MZ.find('build_one windows amd64'))
check('it is skipped for an update ZIP (--no-engine)', 'if [ "$WITH_ENGINE" -eq 1 ]; then\n    eng=' in guard)


def run_guard(files, with_engine=1):
    with tempfile.TemporaryDirectory() as tmp:
        eng = Path(tmp) / 'linux-amd64' / 'llama-cpp'
        if files is not None:
            eng.mkdir(parents=True)
            for f in files:
                (eng / f).write_text('x')
        script = 'set -e\nWITH_ENGINE=%d\n%s\necho GUARD-PASSED\n' % (with_engine, guard)
        return subprocess.run(['bash', '-c', script], cwd=tmp, capture_output=True, text=True, timeout=20)


COMMON = ['llama-server', 'libllama.so', 'libggml-base.so', 'libggml-cpu-x64.so', 'libllama-server-impl.so']

r = run_guard(COMMON + ['libggml-vulkan.so'])
check('the Vulkan engine passes', r.returncode == 0 and 'GUARD-PASSED' in r.stdout, r.stderr)

r = run_guard(COMMON)
check('the CPU-only engine is refused', r.returncode != 0 and 'GUARD-PASSED' not in r.stdout, r.stdout)
check('and the message says why and what to use instead',
      'CPU-only' in r.stderr and 'bin-ubuntu-vulkan-x64.tar.gz' in r.stderr and 'GPU_SHA256' in r.stderr, r.stderr)

r = run_guard(None)
check('a missing engine is refused', r.returncode != 0 and 'llama-server is missing' in r.stderr, r.stderr)

r = run_guard(None, with_engine=0)
check('an update ZIP needs no engine', r.returncode == 0 and 'GUARD-PASSED' in r.stdout, r.stderr)

check('build-deb.sh refuses the CPU-only engine the same way',
      'libggml-vulkan.so' in BUILD_DEB and 'it is a CPU-only build' in BUILD_DEB)

pin = (ROOT / 'engine.sha256').read_text()
check('the pin the message points at is there', 'GPU_SHA256=' in pin and 'LLAMA_BUILD=' in pin)

print('\n%d passed, %d failed' % (passed, failed))
raise SystemExit(1 if failed else 0)
