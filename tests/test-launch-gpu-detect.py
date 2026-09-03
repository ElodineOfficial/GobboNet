#!/usr/bin/env python3
"""Invariants for launch.bat's GPU-offload check (issue #33).

STEP 3b decides whether llama.cpp actually used the GPU by reading strings out
of the engine's log. That is a check built on someone else's log wording, and
upstream has already moved those strings once, so the arrangement that keeps it
working is worth pinning:

  * the chat server is started with -lv, because llama.cpp files the offload
    lines above the default log threshold and they never arrive without it
  * the verbosity is at least 4 (trace), which is where GGML_LOG_LEVEL_INFO
    lands after common_get_verbosity remaps it
  * the variable is set before it is used, since batch reads top to bottom
  * the embedding server does not get -lv, because nothing reads its log
  * the check accepts more than one spelling of the evidence

Run:  python3 test-launch-gpu-detect.py
"""
import os
import re
import sys

# Resolved from this file rather than the working directory, so the check
# behaves the same whether it is run from tests/ or from the repo root.
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

    def code(pred):
        """Line numbers of non-comment lines matching pred."""
        out = []
        for i, l in enumerate(lines, 1):
            s = l.strip()
            if s.startswith("::") or s.lower().startswith("rem "):
                continue
            if pred(l):
                out.append(i)
        return out

    print("launch.bat GPU-offload detection (issue #33)\n")

    # -- the knob exists and is set high enough -----------------------------
    setters = [l for l in lines if l.strip().startswith('set "LOG_VERBOSITY=')]
    check("LOG_VERBOSITY is defined", len(setters) == 1,
          f"found {len(setters)} definitions, want exactly 1")

    level = None
    if setters:
        m = re.search(r'set "LOG_VERBOSITY=(\d+)"', setters[0])
        level = int(m.group(1)) if m else None
    check("verbosity >= 4 (trace, where llama/ggml INFO lands)",
          level is not None and level >= 4,
          f"LOG_VERBOSITY={level}; below 4 the offload lines are filtered out")

    # -- defined before used, because batch runs top to bottom --------------
    defs = code(lambda l: l.strip().startswith('set "LOG_VERBOSITY='))
    uses = code(lambda l: "LOG_VERBOSITY!" in l)
    check("defined before every use", bool(defs) and all(u > defs[0] for u in uses),
          f"defined at {defs}, used at {uses}")

    # -- the chat server actually receives it -------------------------------
    chat = [l for l in lines if "--model" in l and "!GGUF_PATH!" in l and "!SERVER_EXE!" in l]
    check("chat server command exists", len(chat) == 1,
          f"found {len(chat)}")
    check("chat server is passed -lv",
          bool(chat) and re.search(r"-lv\s+!LOG_VERBOSITY!", chat[0]) is not None,
          "without -lv the offload lines never reach the log")

    # -- the embedding server is left alone ---------------------------------
    embed = [l for l in lines if "--embeddings" in l and "!SERVER_EXE!" in l]
    check("embedding server command exists", len(embed) == 1)
    check("embedding server is NOT passed -lv",
          bool(embed) and "-lv" not in embed[0],
          "nothing reads the embedding log; extra verbosity is pure noise")

    # -- the check accepts more than one spelling ---------------------------
    probe = [l for l in lines if "GPU_CONFIRMED=1" in l or ("findstr" in l and "offload" in l)]
    findstr_line = next((l for l in lines if "findstr" in l and "offloaded" in l), "")
    pats = re.findall(r'/c:"([^"]+)"', findstr_line)
    check("offload check looks for several patterns", len(pats) >= 5,
          f"only {len(pats)}: {pats}")
    for needed in ("offloaded", "offloading", "Vulkan0", "CUDA0"):
        check(f"  accepts {needed!r}", needed in pats)

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
