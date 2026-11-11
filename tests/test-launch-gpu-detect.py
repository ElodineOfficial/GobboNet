#!/usr/bin/env python3
"""The GPU-offload check (issue #33) lives in gobbonet.exe, not launch.bat.

Up to 1.7.9 launch.bat's STEP 3b decided whether llama.cpp used the GPU by
grepping the log of the llama-server it started, which needed -lv 4 on that
command line because llama.cpp files the offload lines above the default
threshold. 1.8.0 removed launch.bat's own llama-server start; gobbonet.exe
starts the chat model and reads the same lines off the engine's output as they
stream past (internal/supervisor/engineout.go).

So the arrangement pinned here moved with it:

  * launch.bat carries no offload grep and no LOG_VERBOSITY any more -- a
    leftover would be a check that can never see anything
  * the embedding server, which gobbonet.exe also starts since 1.8.0 (#15),
    does not get -lv, because nothing reads its log for offload lines
  * the Go check accepts more than one spelling of the evidence, because these
    strings are llama.cpp's log wording, not an interface it owes us
  * the Go command line passes -lv 4 (trace, where llama/ggml INFO lands)

Run:  python3 test-launch-gpu-detect.py
"""
import os
import re
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
    raw = open(BAT, "rb").read().decode("utf-8", errors="surrogateescape")
    lines = raw.replace("\r\n", "\n").split("\n")
    code = [l for l in lines if not l.strip().startswith("::") and not l.strip().lower().startswith("rem ")]

    print("launch.bat GPU-offload check (issue #33), after 1.8.0\n")
    check("no LOG_VERBOSITY left in launch.bat", not any("LOG_VERBOSITY" in l for l in code))
    check("no offload grep left in launch.bat",
          not any("findstr" in l and "offload" in l for l in code))
    check("launch.bat starts no embedding server either (1.8.0, #15)",
          not any("--embeddings" in l for l in code))
    emb = open(os.path.join(ROOT, "internal", "supervisor", "embed.go")).read()
    fn = emb[emb.find("func EmbedArgs("):]
    fn = fn[:fn.find("\n}\n")]
    check("the embedding server, which gobbonet.exe starts, is NOT passed -lv",
          "--embeddings" in fn and '"-lv"' not in fn,
          "nothing reads the embedding log for offload lines; extra verbosity is pure noise")

    print("\ngobbonet.exe's check")
    src = open(os.path.join(ROOT, "internal", "supervisor", "engineout.go")).read()
    m = re.search(r"var offloadMarkers = \[\]string\{(.*?)\}", src, re.S)
    pats = re.findall(r'"([^"]+)"', m.group(1)) if m else []
    check("offload check looks for several patterns", len(pats) >= 5, f"only {len(pats)}: {pats}")
    for needed in ("offloaded", "offloading", "Vulkan0", "CUDA0"):
        check(f"  accepts {needed!r}", needed in pats)
    sup = open(os.path.join(ROOT, "internal", "supervisor", "supervisor.go")).read()
    lv = re.search(r'"-lv",\s*"(\d+)"', sup)
    check("the chat server is started with -lv 4 or more",
          lv is not None and int(lv.group(1)) >= 4,
          "below 4 the offload lines are filtered out before they are emitted")

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
