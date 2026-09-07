#!/usr/bin/env python3
"""Invariants for setup-lan.bat and teardown-lan.bat.

Neither script can be exercised on CI -- they need Administrator on Windows and
a real firewall to talk to -- so the arrangement that makes them correct is
pinned here instead, the same way test-launch-gpu-detect.py pins launch.bat's
offload check.

Everything below is a bug that shipped:

  * the port was resolved from .gobbonet-port, which the server writes only
    AFTER it binds. The installer's finish page starts the server and this
    script in the same second, so the file had never existed yet and the rule
    landed on the fallback port. Ask the binary instead -- it knows before the
    server has ever run.
  * only GEMMA_LISTEN_PORT was read, while the binary prefers
    GOBBONET_LISTEN_PORT and warns the old spelling is deprecated. Anyone who
    followed the deprecation moved the server and not the firewall.
  * profile=private,public omitted domain, so a domain-joined machine got no
    rule at all and no message saying so.
  * nothing cleared the program-scoped Block rules Windows writes when the
    "Allow access?" prompt is dismissed. A Block rule beats an Allow rule, so
    the port rule below it was overridden while this script printed [OK].
  * the program allow rule must stay scoped to LocalSubnet. Widening it would
    expose a password-protected but UNENCRYPTED chat to any network the machine
    later joins.

Run:  python3 test-setup-lan.py
"""
import os
import re
import sys

# Resolved from this file rather than the working directory, so the check
# behaves the same whether it is run from tests/ or from the repo root.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUP = os.path.join(ROOT, "setup-lan.bat")
TEARDOWN = os.path.join(ROOT, "teardown-lan.bat")
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def read(path):
    return open(path, "rb").read().decode("utf-8", errors="surrogateescape").replace("\r\n", "\n")


def code_lines(raw):
    """Lines with comments stripped, so a rule named in prose does not count."""
    out = []
    for line in raw.split("\n"):
        s = line.strip()
        if s.startswith("::") or s.lower().startswith("rem "):
            continue
        out.append(line)
    return out


def main():
    setup_raw = read(SETUP)
    setup = "\n".join(code_lines(setup_raw))
    teardown = "\n".join(code_lines(read(TEARDOWN)))

    print("port resolution")
    ask = setup.find("gobbonet.exe\" config get listen_port")
    sidecar = setup.find(".gobbonet-port")
    check("asks the binary for the effective port", ask != -1,
          "setup-lan.bat must run `gobbonet config get listen_port`")
    check("asks BEFORE falling back to .gobbonet-port", ask != -1 and ask < sidecar,
          "the sidecar does not exist yet on a first run; the binary always knows")
    check("still falls back to .gobbonet-port", sidecar != -1,
          "the launch.bat/fileserver.ps1 path has no gobbonet.exe to ask")
    check("reads GOBBONET_LISTEN_PORT", "GOBBONET_LISTEN_PORT" in setup)
    check("still reads the deprecated GEMMA_LISTEN_PORT", "GEMMA_LISTEN_PORT" in setup)
    g_new = setup.find("GOBBONET_LISTEN_PORT")
    g_old = setup.find("GEMMA_LISTEN_PORT")
    check("GOBBONET_ wins over GEMMA_", g_new > g_old,
          "the later `set` wins in batch, so the current spelling must come second")

    print("\nfirewall rules")
    for rule in re.findall(r'firewall (?:add|set) rule[^\n]*', setup):
        if "profile=" in rule:
            check(f"  domain profile included: {rule[:52]}...", "domain" in rule,
                  "a domain-joined machine otherwise gets no rule and no warning")
        if "action=allow" in rule:
            check(f"  scoped to LocalSubnet: {rule[:52]}...", "remoteip=LocalSubnet" in rule,
                  "the chat is password-protected but NOT encrypted -- never open it wide")

    print("\nblock rules")
    check("looks for Block rules on gobbonet.exe",
          "Get-NetFirewallRule" in setup and "-Action Block" in setup)
    check("removes them", "Remove-NetFirewallRule" in setup,
          "a Block rule overrides the Allow rule, silently")
    check("adds a program rule so the prompt cannot recur",
          re.search(r'add rule name="GobboNet"[^\n]*program=', setup) is not None)
    check("program rule is guarded by gobbonet.exe existing",
          setup.find('if exist "%~dp0gobbonet.exe"') < setup.find('name="GobboNet"'),
          "the launch.bat path serves from powershell.exe; a rule for THAT would "
          "open every PowerShell script on the machine")

    print("\nteardown symmetry")
    added = set(re.findall(r'firewall add rule name="([^"]+)"', setup))
    dropped = set(re.findall(r'drop_rule "([^"]+)"', teardown))
    for name in sorted(added):
        check(f"  {name} is removed by teardown-lan.bat", name in dropped,
              "an uninstall would otherwise leave a rule naming a path that is gone")

    print("\ndelayed expansion")
    check("EnableDelayedExpansion is on", "setlocal EnableDelayedExpansion" in setup_raw)
    early = []
    depth = 0
    for i, line in enumerate(setup_raw.split("\n"), 1):
        s = line.strip()
        if s.startswith("::") or s.lower().startswith("rem "):
            continue
        if depth > 0:
            for m in re.findall(r"%(WEB_PORT|LLM_PORT|GN_BLOCKED|WEB_PORT_SRC)%", line):
                early.append(f"line {i}: %{m}%")
        depth = max(0, depth + line.count("(") - line.count(")"))
    check("no %VAR% reads inside blocks", not early,
          "; ".join(early) + "  -- these expand once, before the block runs, so the "
          "rule is written for a port literally called %WEB_PORT%")

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
