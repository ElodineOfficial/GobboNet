#!/usr/bin/env python3
"""The llama-server command line must not drift between the two launch paths.

GobboNet starts llama-server from two places:

  launch.bat  :start_server   -- the legacy PowerShell/batch path
  Supervisor.BuildArgs        -- the Go path, used by BOTH the .deb and the
                                 Windows installer

BuildArgs' own doc comment says it "mirrors the argument set launch.bat
constructs in its :start_server block". That claim is load-bearing and was
already not quite true, so it is checked here rather than trusted.

Why this file exists: issue #33 was two bugs in one report, and they live in
different places.

  * dry_penalty_last_n rejected by newer llama.cpp (HTTP 400). Fixed in
    js/06-state-sync.js -- frontend, so it ships identically in the .deb and
    the .exe. Covered by the mjs suites and asserted again at the bottom here,
    because "does the Linux package carry it" is a packaging question.

  * -lv, the log verbosity that makes llama.cpp file the lines launch.bat's
    STEP 3b greps to confirm GPU offload. That one is batch-only.

KNOWN_BATCH_ONLY below records the second as a deliberate, reviewed difference
rather than letting it sit as an untracked gap. If someone adds offload
detection to the Go path, -lv has to move with it, and this test is where that
gets noticed.

Run:  python3 test-engine-args.py
"""
import os
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


# Flags launch.bat passes that BuildArgs deliberately does not, with the reason.
# Anything NOT listed here that appears on one side and not the other is drift.
KNOWN_BATCH_ONLY = {
    "-lv": "log verbosity for launch.bat's STEP 3b offload grep; the Go path "
           "does no log-based offload confirmation, so nothing would read it",
}

# Flags BuildArgs passes that launch.bat does not. The Go server owns config
# the batch path never had.
KNOWN_GO_ONLY = {
    "--api-key":            "llm_api_key, a Go-config-only setting",
    "--jinja":              "conditional; launch.bat interpolates !JINJA_FLAG!",
    "--chat-template":      "conditional; launch.bat uses !CHAT_TEMPLATE_FLAG!",
    "--chat-template-file": "conditional; same",
}


def batch_flags():
    src = read("launch.bat")
    line = [l for l in src.split("\r\n") if "SERVER_EXE" in l and "--model" in l]
    if not line:
        return None
    return set(re.findall(r"(?<![\w-])(--?[a-z][a-z-]*)", line[0]))


def go_flags():
    src = read("internal/supervisor/supervisor.go")
    m = re.search(r"func \(s \*Supervisor\) BuildArgs.*?\n}\n", src, re.S)
    if not m:
        return None
    return set(re.findall(r'"(--?[a-z][a-z-]*)"', m.group(0)))


def main():
    print("llama-server command line: batch vs Go")
    bat, go = batch_flags(), go_flags()
    check("  found launch.bat :start_server line", bat is not None)
    check("  found Supervisor.BuildArgs", go is not None)
    if not bat or not go:
        print("\nFAILED")
        return 1

    # Core flags. If any of these stops being passed on either side, one
    # platform is running llama-server differently from the other.
    for flag in ("--model", "--port", "--host", "--ctx-size", "--n-gpu-layers",
                 "--cache-type-k", "--cache-type-v", "--parallel",
                 "--reasoning-format"):
        check(f"  {flag} on both paths", flag in bat and flag in go,
              f"batch={flag in bat} go={flag in go}")

    print("\ndifferences are accounted for")
    for flag in sorted(bat - go):
        check(f"  batch-only {flag} is a known difference", flag in KNOWN_BATCH_ONLY,
              "undocumented drift -- add it to KNOWN_BATCH_ONLY with a reason, "
              "or pass it in BuildArgs")
        if flag in KNOWN_BATCH_ONLY:
            print(f"        reason: {KNOWN_BATCH_ONLY[flag]}")
    for flag in sorted(go - bat):
        check(f"  go-only {flag} is a known difference", flag in KNOWN_GO_ONLY,
              "undocumented drift")

    print("\nthe -lv invariant (#33)")
    # If offload detection ever lands on the Go path, -lv has to come with it.
    # Comments stripped first. The doc comment on BuildArgs necessarily NAMES
    # these tokens while explaining why it does not grep for them, so a raw
    # substring search over the file reports the opposite of the truth.
    server_go = read("internal/supervisor/supervisor.go")
    code_only = "\n".join(l for l in server_go.split("\n")
                          if not l.lstrip().startswith("//"))
    greps_log = any(t in code_only for t in ("offloaded", "offloading", "Vulkan0", "CUDA0"))
    check("  Go path either greps for offload AND passes -lv, or does neither",
          greps_log == ("-lv" in go),
          "the Go path reads offload lines out of the log but does not ask "
          "llama.cpp to emit them -- llama.cpp files those above the default "
          "threshold, which is the whole reason launch.bat passes -lv")

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
