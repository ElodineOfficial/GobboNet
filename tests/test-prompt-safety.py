#!/usr/bin/env python3
"""Invariants for the confirmation prompts and the PowerShell sanitizers.

Covers PR #30 items 1 and 2, both reported by John McCardle.

Neither can be exercised on CI: launch.bat needs an interactive console on
Windows, and identify-model.ps1 needs a real GGUF and a PowerShell host. The
PR suggested parsing the PowerShell with its own AST under `podman run
mcr.microsoft.com/powershell` — a good idea, and this file does the same job
without needing pwsh present, so it runs anywhere the rest of the suite does.

What shipped, and must not come back:

  1. :prompt_yn never cleared its shared _YN variable. `set /p` leaves a
     variable UNTOUCHED when the user submits an empty line, so a Y typed at
     one question was re-read as the answer to the next. The pair that made
     that dangerous is the llama.cpp download prompt followed by the
     unpinned-hash gate — everyone answers Y to the first, and the second is
     the one that exists to make someone consciously accept an unverified
     executable. The gate failed OPEN.

  2. identify-model.ps1 ran a FILESYSTEM PATH through the argument sanitizer,
     which strips % ! ^ & — all four legal in Windows paths. It did not fail
     loudly; it silently produced a different path, and the symptom was
     llama-server refusing a template that was plainly present.

Run:  python3 test-prompt-safety.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCH = os.path.join(ROOT, "launch.bat")
IDENTIFY = os.path.join(ROOT, "identify-model.ps1")
FILESERVER = os.path.join(ROOT, "fileserver.ps1")
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def read(path):
    return open(path, "rb").read().decode("utf-8", errors="surrogateescape").replace("\r\n", "\n")


def routine(src, label):
    """The body of a :label subroutine, up to the next REAL label.

    '::' is batch's comment syntax and also starts with a colon, so the stop
    condition has to be a colon NOT followed by another one — otherwise every
    routine looks empty and every assertion below silently passes on nothing.
    """
    m = re.search(r"^:%s\n(.*?)(?=^:[^:]|\Z)" % re.escape(label), src, re.S | re.M)
    return m.group(1) if m else ""


def code(block):
    return "\n".join(l for l in block.split("\n")
                     if not l.strip().startswith("::") and not l.strip().lower().startswith("rem "))


def main():
    launch = read(LAUNCH)
    identify = read(IDENTIFY)
    fileserver = read(FILESERVER)

    print("prompt hygiene (item 1)")
    for label in ("prompt_yn", "prompt_confirm"):
        body = code(routine(launch, label))
        check(f"  :{label} exists", bool(body.strip()))
        # The load-bearing line. Without it an empty answer inherits the last one.
        clears = re.findall(r'^\s*set\s+"_YN="\s*$', body, re.M)
        read_at = body.find("set /p")
        first_clear = body.find('set "_YN="')
        check(f"  :{label} clears _YN before reading",
              first_clear != -1 and read_at != -1 and first_clear < read_at,
              "set /p leaves the variable untouched on empty input")
        check(f"  :{label} clears _YN after reading too", len(clears) >= 2,
              "a stale answer must not outlive the call")
        check(f"  :{label} defaults the result to N",
              re.search(r'^\s*set\s+"%~2=N"', body, re.M) is not None,
              "the result must fail closed, not inherit")

    strict = code(routine(launch, "prompt_confirm"))
    check("  :prompt_confirm accepts only the whole word YES",
          '=="YES"' in strict and '=="Y"' not in strict.replace('=="YES"', ""),
          "a buffered Y from an earlier prompt must not satisfy this one")

    print("\nthe unverified-binary gate uses the strict prompt")
    gate = re.search(r'call :(\w+)\s+"[^"]*UNVERIFIED[^"]*"\s+(\w+)', launch)
    check("  gate call found", gate is not None)
    if gate:
        check(f"  gate uses :prompt_confirm (found :{gate.group(1)})",
              gate.group(1) == "prompt_confirm",
              "this is the prompt that decides whether to run an unverified executable")
        check("  gate result is checked fail-closed",
              re.search(r'if /i not "!%s!"=="Y"' % gate.group(2), launch) is not None,
              "anything other than an explicit Y must abort")

    print("\nevery prompt shares the fixed routines")
    for m in re.finditer(r'^\s*call :(prompt_\w+)', launch, re.M):
        check(f"  {m.group(1)} is one of the two audited routines",
              m.group(1) in ("prompt_yn", "prompt_confirm"))
    # _YN may be read in exactly two places: the two routines above. Anything
    # else is a prompt that skipped the clearing and can inherit a stale answer.
    total = len(re.findall(r"set /p\s+\"_YN=", code(launch)))
    inside = sum(len(re.findall(r"set /p\s+\"_YN=", code(routine(launch, r))))
                 for r in ("prompt_yn", "prompt_confirm"))
    check("  no inline _YN read bypasses them", total == inside == 2,
          f"{total} reads of _YN, {inside} of them inside the audited routines")

    print("\nPowerShell sanitizers (item 2)")
    check("  identify-model.ps1 defines a path-safe sanitizer",
          "function ConvertTo-BatchPathSafe" in identify,
          "paths need the gentler one; the arg sanitizer corrupts them")

    # The gentle one must NOT strip characters that are legal in Windows paths.
    body = re.search(r"function ConvertTo-BatchPathSafe.*?\n}", identify, re.S)
    check("  path-safe body found", body is not None)
    if body:
        b = body.group(0)
        for ch in "%!^&":
            check(f"  path-safe does not strip '{ch}' (legal in Windows paths)",
                  f"[%!^&<>|\"]" not in b,
                  "stripping these silently rewrites a valid path")
        check("  path-safe still removes the quote", "'\"'" in b or '\'"\'' in b,
              "a quote would escape the set \"VAR=...\" it lands in")
        check("  path-safe still removes CR/LF", "\\r\\n" in b,
              "a newline would append a command of its own")

    print("\n  every emitted value is sanitized, and with the right one")
    for line in re.findall(r"\('set \"MODEL_[A-Z_]+=.*?\),", identify, re.S):
        field = re.search(r"MODEL_([A-Z_]+)=", line).group(1)
        cast = "[int]" in line
        safe = "ConvertTo-Batch" in line
        check(f"    MODEL_{field} is sanitized or numerically cast", cast or safe,
              "every one of these is a command-injection sink")
        if field.endswith("_FILE"):
            check(f"    MODEL_{field} uses the PATH sanitizer",
                  "ConvertTo-BatchPathSafe" in line,
                  "it is a path; the arg sanitizer would corrupt it")

    print("\n  fileserver.ps1 keeps both halves (the file this was learned on)")
    for fn in ("ConvertTo-CmdArgSafe", "ConvertTo-CmdPathSafe"):
        check(f"    {fn} still present", f"function {fn}" in fileserver)

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
