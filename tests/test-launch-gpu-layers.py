#!/usr/bin/env python3
"""Where launch.bat turns automatic GPU placement (-1) into 99 layers.

GPU_LAYERS defaults to -1: automatic placement, which gobbonet.exe performs
after checking that the engine supports --fit. Only the managed path has that
check, so the conversion to a fixed 99 layers belongs to the legacy path alone:

  * the managed hand-off (gobbonet.exe present) must keep -1, or automatic
    placement never reaches the config it writes with `config set gpu_layers`
  * the legacy path (no gobbonet.exe, or GOBBONET_LEGACY_SERVER=1) must convert
    before llama-server is started, and before GEMMA_GPU_LAYERS is exported
    for fileserver.ps1's hot-swaps -- 1.7.5 started it with 99 layers

An earlier change placed the conversion after both jumps to the legacy path,
so it ran only on the managed path: the legacy engine received
--n-gpu-layers -1, and the managed launch wrote 99 over automatic placement.

Run:  python3 test-launch-gpu-layers.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAT = os.path.join(ROOT, "launch.bat")
failures = []

CONVERT = 'if "!GPU_LAYERS!"=="-1" ('
SET_99 = 'set "GPU_LAYERS=99"'


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def index_of(lines, predicate, start=0):
    for i in range(start, len(lines)):
        if predicate(lines[i]):
            return i
    return -1


def main():
    raw = open(BAT, "rb").read()
    bare_lf = raw.count(b"\n") - raw.count(b"\r\n")
    check("line endings stay CRLF throughout", bare_lf == 0, f"{bare_lf} bare LF line(s)")
    lines = raw.decode("utf-8", errors="surrogateescape").replace("\r\n", "\n").split("\n")
    stripped = [l.strip() for l in lines]

    default = index_of(stripped, lambda l: l.startswith('set "GPU_LAYERS='))
    check("the default is automatic placement",
          default >= 0 and stripped[default] == 'set "GPU_LAYERS=-1"', stripped[default] if default >= 0 else "")

    to_legacy = [i for i, l in enumerate(stripped) if l.endswith("goto :start_server_legacy")]
    label = index_of(stripped, lambda l: l == ":start_server_legacy")
    handoff_end = index_of(stripped, lambda l: l == "goto :start_embed", to_legacy[-1] if to_legacy else 0)
    check("both jumps to the legacy path exist", len(to_legacy) == 2, str(to_legacy))
    check("the legacy label follows the managed hand-off", 0 <= handoff_end < label)

    managed = stripped[(to_legacy[-1] + 1 if to_legacy else 0):handoff_end]
    check("the managed hand-off does not convert -1 to 99",
          not any(CONVERT in l or SET_99 in l for l in managed),
          "\n        ".join(l for l in managed if l))

    convert = index_of(stripped, lambda l: CONVERT in l, label)
    engine = index_of(stripped, lambda l: "--n-gpu-layers !GPU_LAYERS!" in l, label)
    export = index_of(stripped, lambda l: l == 'set "GEMMA_GPU_LAYERS=!GPU_LAYERS!"', label)
    check("the legacy path converts -1 to 99", convert > label and SET_99 in stripped[convert + 2],
          f"label at {label + 1}, conversion at {convert + 1}")
    check("before the legacy llama-server command line", 0 <= convert < engine,
          f"conversion {convert + 1}, engine {engine + 1}")
    check("before GEMMA_GPU_LAYERS is exported for hot-swaps", 0 <= convert < export,
          f"conversion {convert + 1}, export {export + 1}")
    check("the conversion appears exactly once",
          sum(CONVERT in l for l in stripped) == 1)

    handoff_set = index_of(stripped, lambda l: 'config set gpu_layers' in l and '"!GPU_LAYERS!"' in l)
    check("the managed launch hands GPU_LAYERS to gobbonet.exe as-is", handoff_set > 0)

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
