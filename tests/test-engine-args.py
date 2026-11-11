#!/usr/bin/env python3
"""One llama-server command line for the chat model, built in one place.

Up to 1.7.9 GobboNet could start the chat model from two places:

  launch.bat  :start_server   -- the legacy batch/PowerShell path
  Supervisor.BuildArgs        -- the Go path, used by every package

and this file checked that the two did not drift. 1.8.0 removed the batch one:
gobbonet.exe starts the chat model on Windows too, and since 1.8.0 (#15) the
optional embedding server as well (EmbedArgs), so launch.bat starts no
llama-server at all. What is pinned now is that it stays that way, and that
BuildArgs keeps the flags both paths always had.

Why this file exists: issue #33 was two bugs in one report, and they live in
different places.

  * dry_penalty_last_n rejected by newer llama.cpp (HTTP 400). Fixed in
    js/06-state-sync.js -- frontend, so it ships identically in the .deb and
    the .exe. Covered by the mjs suites and asserted again at the bottom here,
    because "does the Linux package carry it" is a packaging question.

  * -lv, the log verbosity that makes llama.cpp emit the lines the GPU-offload
    check reads. The check lives in Go now, so -lv has to be on the Go command
    line, and this test is where a mismatch gets noticed.

Run:  python3 test-engine-args.py
"""
import os
import pathlib
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def read(path):
    return open(os.path.join(ROOT, path), "rb").read().decode("utf-8", errors="surrogateescape")


def batch_flags():
    """Every llama-server command line launch.bat writes."""
    src = read("launch.bat")
    return [l for l in src.split("\r\n") if "SERVER_EXE" in l and "--model" in l]


def go_flags():
    src = read("internal/supervisor/supervisor.go")
    m = re.search(r"func \(s \*Supervisor\) BuildArgs.*?\n}\n", src, re.S)
    if not m:
        return None
    return set(re.findall(r'"(--?[a-z][a-z-]*)"', m.group(0)))


def main():
    print("llama-server command lines")
    bat, go = batch_flags(), go_flags()
    check("  found Supervisor.BuildArgs", go is not None)
    check("  launch.bat starts no llama-server at all",
          bat is not None and len(bat) == 0,
          "1.8.0: gobbonet.exe starts the chat model (#13) and the embedding server (#15)")
    if not go:
        print("\nFAILED")
        return 1

    # Core flags. If any of these stops being passed, the chat model runs
    # differently from every earlier release.
    for flag in ("--model", "--port", "--host", "--ctx-size", "--n-gpu-layers",
                 "--cache-type-k", "--cache-type-v", "--parallel",
                 "--reasoning-format", "--jinja", "--no-jinja", "--chat-template"):
        check(f"  BuildArgs passes {flag}", flag in go)
    # The embedding server's command line is Go's too since 1.8.0 (#15).
    emb = read("internal/supervisor/embed.go")
    m = re.search(r"func EmbedArgs\(.*?\n}\n", emb, re.S)
    eflags = set(re.findall(r'"(--?[a-z][a-z-]*)"', m.group(0))) if m else set()
    check("  found EmbedArgs", m is not None)
    for flag in ("--model", "--host", "--port", "--embeddings", "--pooling", "--ctx-size",
                 "--batch-size", "--ubatch-size", "--n-gpu-layers"):
        check(f"  EmbedArgs passes {flag}", flag in eflags)
    check("  and not -lv (nothing reads the embedding log for offload lines)", "-lv" not in eflags)

    print("\nthe -lv invariant (#33)")
    # If offload detection ever lands on the Go path, -lv has to come with it.
    # Comments stripped first. The doc comment on BuildArgs necessarily NAMES
    # these tokens while explaining why it does not grep for them, so a raw
    # substring search over the file reports the opposite of the truth.
    # The whole package, not one file. The offload markers moved to
    # internal/supervisor/engineout.go in 1.7.5, when the check stopped being a
    # log grep and became a scan of the engine's output as it streams past. A
    # per-file search reported "does not grep" while the package plainly did,
    # and the invariant is about the package's behaviour either way.
    pkg = pathlib.Path(ROOT) / "internal" / "supervisor"
    code_only = ""
    for f in sorted(pkg.glob("*.go")):
        if f.name.endswith("_test.go"):
            continue
        code_only += "\n".join(l for l in f.read_text().split("\n")
                                if not l.lstrip().startswith("//"))
    greps_log = any(t in code_only for t in ("offloaded", "offloading", "Vulkan0", "CUDA0"))
    check("  Go path either greps for offload AND passes -lv, or does neither",
          greps_log == ("-lv" in go),
          "the Go path reads offload lines out of the log but does not ask "
          "llama.cpp to emit them -- llama.cpp files those above the default "
          "threshold, which is why the check needs -lv")

    print("\ndry_penalty_last_n reaches every package (#33, other half)")
    sync = read("js/06-state-sync.js")
    check("  resolveDryPenaltyLastN exists", "function resolveDryPenaltyLastN" in sync)
    check("  the sampler payload uses it",
          re.search(r"dry_penalty_last_n:\s*resolveDryPenaltyLastN\(", sync) is not None,
          "sending the old sentinel gets HTTP 400 from newer llama.cpp")
    check("  it is not hardcoded back to a literal",
          re.search(r"dry_penalty_last_n:\s*-?\d", sync) is None)
    # 06-state-sync.js is frontend, so it ships via stage-web.sh into web/ --
    # the same payload the .deb and the .exe both carry. Platform-independent
    # by construction, which is why the Linux package gets the fix for free.
    check("  06-state-sync.js is a staged frontend module",
          'src="js/06-state-sync.js"' in read("chat.html"),
          "if it stopped being loaded, no package would carry the fix")

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
