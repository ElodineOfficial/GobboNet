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
    # 1.7.9 (PR #7): rules take their profiles from GN_PROFILES (or, for the
    # built-in mDNS rules, one profile at a time from GN_PROFILE_LIST). The
    # default must still include domain; Public only by choice.
    default = re.search(r'^set "GN_PROFILES=([^"]*)"', setup, re.M)
    check("  default profiles are domain,private (Public only by choice)",
          default is not None and default.group(1) == "domain,private",
          default.group(1) if default else "GN_PROFILES not set")
    check("  the per-profile list matches", 'set "GN_PROFILE_LIST=domain private"' in setup)
    for rule in re.findall(r'firewall (?:add|set) rule[^\n]*', setup):
        if "profile=" in rule:
            check(f"  profiles come from the choice: {rule[:52]}...",
                  "profile=!GN_PROFILES!" in rule or "profile=%%F" in rule,
                  "a hard-coded profile list bypasses the Public decision")
            check(f"  never hard-codes public: {rule[:52]}...", "public" not in rule.lower().split("profile=", 1)[1].split()[0])
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

    # Issue #63: the window title, the banner and two rule names still said
    # Gemma 4, the model the project started with. The rules are renamed, and
    # an upgraded machine's old ones are replaced -- deleted, but only after
    # the rule that takes over is confirmed, so a failed add never strands the
    # phone without one.
    print("\nrule and window names (issue #63)")
    check("the window title and banner say GobboNet",
          "title GobboNet -- LAN Access Setup" in setup and "GOBBONET -- LAN ACCESS SETUP" in setup
          and not re.search(r"(?i)gemma\s*4\s*--", setup))
    check("no Gemma4-* rule is added or modified any more",
          not re.search(r'firewall (?:add|set) rule name="Gemma4', setup),
          re.findall(r'firewall (?:add|set) rule name="Gemma4[^"]*"', setup))
    for old, new_ok in (("Gemma4-Web", 'show rule name="GobboNet-Web"'), ("Gemma4-mDNS", "if defined GN_MDNS_OK")):
        delete = setup.find(f'delete rule name="{old}"')
        guard = setup.rfind(new_ok, 0, delete)
        check(f"  {old} is replaced: deleted only after its replacement is confirmed",
              delete != -1 and guard != -1 and setup.count(f'delete rule name="{old}"') == 1)
        check(f"  {old} is still removed by teardown-lan.bat (upgraded installs)",
              f'drop_rule "{old}"' in teardown)
    mdns = setup[setup.find('set "GN_MDNS_OK="'):setup.find("if defined GN_MDNS_OK")]
    check("  mDNS success is judged by netsh exit codes, not its translated output",
          "findstr" not in mdns and mdns.count('set "GN_MDNS_OK=1"') == 3,
          "netsh prints Enabled/Aktiviert/Activé; matching any of them fails on the others")

    print("\nPublic networks (1.7.9, PR #7)")
    pub = setup.find(":profiles_public")
    check("  /public is the explicit switch", 'if /i "%~1"=="/public" goto :profiles_public' in setup)
    check("  public is added only under :profiles_public",
          setup.count('set "GN_PROFILES=domain,private,public"') == 1 and
          setup.find('set "GN_PROFILES=domain,private,public"') > pub > 0)
    check("  a Public network is detected and the user is asked",
          "Get-NetConnectionProfile" in setup and "choice /c PAS" in setup)
    check("  an unanswered question times out to skip, never to Public", "/t 60 /d S" in setup)
    check("  [P] makes the network Private", "-NetworkCategory Private" in setup)
    check("  the built-in mDNS rules are enabled, never re-scoped",
          'set rule name="mDNS (UDP-In)" profile=%%F new enable=yes' in setup and
          not re.search(r'set rule name="mDNS \(UDP-In\)" new [^\n]*profile=', setup))

    print("\nURL reservation (1.7.9, PR #7)")
    check("  no reservation for Everyone any more", ";;;WD)" not in setup and ";;;WD^)" not in setup)
    check("  granted to the console user's SID", "sddl=D:(A;;GX;;;!GN_ACL_SID!)" in setup and "Win32_ComputerSystem" in setup)
    check("  the SID is validated before use", 'findstr /r "^S-1-[0-9][0-9-]*$"' in setup)
    check("  who gets it is printed", "The reservation will belong to: !GN_ACL_USER!" in setup)
    check("  no SID: skipped, never widened", "if not defined GN_ACL_SID endlocal & goto :eof" in setup)
    acl = setup[setup.find(":add_urlacl"):]
    check("  an existing reservation is replaced, not kept",
          acl.find("http delete urlacl") != -1 and acl.find("http delete urlacl") < acl.find("http add urlacl"))

    print("\nquoting")
    check("  no pipe in any PowerShell call (escaping differs between for /f and a plain line)",
          not [l for l in setup.split("\n") if "powershell" in l.lower() and "|" in l.split("-Command", 1)[-1].split('" 2^>nul')[0].split('" >nul')[0]],
          [l[:90] for l in setup.split("\n") if "powershell" in l.lower() and "|" in l.split("-Command", 1)[-1].split('" 2^>nul')[0].split('" >nul')[0]])
    unesc = []
    depth = 0
    for line in setup.split("\n"):
        t = line.strip()
        if depth > 0 and t.lower().startswith("echo") and re.search(r'(?<!\^)[()]', t[4:].replace("'mDNS ^(UDP-In^)'", "")):
            unesc.append(t[:80])
        q = re.sub(r'"[^"]*"', '', t)
        if not t.lower().startswith(("echo", "rem")):
            depth += q.count("(") - q.count(")")
        depth = max(depth, 0)
    check("  no unescaped ( or ) in an echo inside a block", not unesc, unesc)

    doctor = read(os.path.join(ROOT, "cmd", "gobbonet", "doctor.go"))
    check("  gobbonet doctor knows both names",
          'portRuleName    = "GobboNet-Web"' in doctor and 'portRuleOldName = "Gemma4-Web"' in doctor)

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
