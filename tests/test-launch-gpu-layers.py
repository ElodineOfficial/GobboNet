#!/usr/bin/env python3
"""launch.bat hands automatic GPU placement (-1) to gobbonet.exe untouched.

GPU_LAYERS defaults to -1: automatic placement, which gobbonet.exe performs
after checking that the engine supports --fit. Up to 1.7.9 launch.bat also had
a legacy path that started llama-server itself, without that check, and turned
-1 into a fixed 99 layers for it. An earlier change put that conversion on the
wrong side of the branch, so the managed launch wrote 99 over automatic
placement.

1.8.0 removed the legacy path, and with it the only reason to convert. What
stays pinned: the default is -1, nothing in launch.bat rewrites it, and it is
handed to gobbonet.exe as-is.

Run:  python3 test-launch-gpu-layers.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAT = os.path.join(ROOT, "launch.bat")
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def main():
    raw = open(BAT, "rb").read()
    bare_lf = raw.count(b"\n") - raw.count(b"\r\n")
    check("line endings stay CRLF throughout", bare_lf == 0, f"{bare_lf} bare LF line(s)")
    lines = raw.decode("utf-8", errors="surrogateescape").replace("\r\n", "\n").split("\n")
    code = [l.strip() for l in lines if not l.strip().startswith("::") and not l.strip().lower().startswith("rem ")]

    sets = [l for l in code if l.startswith('set "GPU_LAYERS=')]
    check("the default is automatic placement, set once",
          sets == ['set "GPU_LAYERS=-1"'], sets)
    check("nothing converts -1 to a fixed layer count any more",
          not any('if "!GPU_LAYERS!"=="-1"' in l for l in code))
    check("the legacy llama-server start is gone (1.8.0)",
          not any("--n-gpu-layers !GPU_LAYERS!" in l for l in code),
          "launch.bat starts only the embedding server now; gobbonet.exe starts the chat model")
    check("the managed launch hands GPU_LAYERS to gobbonet.exe as-is",
          any('config set gpu_layers' in l and '"!GPU_LAYERS!"' in l for l in code))

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
