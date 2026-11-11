#!/usr/bin/env python3
"""1.8.0 (#13): the legacy PowerShell server is gone, and stays gone.

Up to 1.7.9, launch.bat had a second path. Without gobbonet.exe, or with
GOBBONET_LEGACY_SERVER=1, it started llama-server itself, served the chat from
fileserver.ps1 (2,108 lines of PowerShell) and watched both from a monitor
loop. 1.7.9 deprecated it; 1.8.0 removed it. gobbonet.exe is the only server.

What this pins:

  * fileserver.ps1 is not in the tree, not in the ZIP manifest, and not in the
    installer's file list -- and the installer deletes a copy an older install
    left, because installing over 1.7 would otherwise keep it.
  * No shipped file names fileserver.ps1 or GOBBONET_LEGACY_SERVER, except the
    places listed in ALLOWED below, each with the reason it still has to. A new
    mention elsewhere is either a leftover instruction ("run fileserver.ps1",
    "set GOBBONET_LEGACY_SERVER") or a new dependency on a file that does not
    ship. Either way it fails here first.
  * Nothing deletes a user's leftover copy behind their back: the installer
    does, as installers do, and gobbonet doctor only points it out.

History is exempt: docs/changelog/ and docs/archive/ describe what was true
when they were written.

Run:  python3 tests/test-legacy-removal.py
"""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


# Every file still allowed to name the old server, and why.
ALLOWED = {
    "fileserver.ps1": {
        "installer-win/gobbonet.nsi": "deletes a stale copy on install; the uninstaller removes it too",
        "installer-win/README.md": "says the installer stopped installing it and deletes the old copy",
        "stop-gobbonet.bat": "stops a copy left running from before an update; it holds the web port",
        "cmd/gobbonet/doctor_leftover.go": "points out a stale copy in the install folder",
        "cmd/gobbonet/doctor_leftover_test.go": "tests that",
        "js/15-cards.js": "recognises a page served by a leftover copy, which names itself",
        "js/22-scheduler.js": "the same, for the About row",
        "README.md": "tells a ZIP updater the leftover can be deleted",
        "TROUBLESHOOTING.md": "the same, where people look when something is odd",
        "AGENTS.md": "says what the name means now, and points here",
        "docs/GO_SERVER.md": "what the Go server replaced",
        "scripts/PATCH-README.txt": "release notes; roadmap #6 rewrites them for 1.8.0 with the ZIP note",
    },
    "GOBBONET_LEGACY_SERVER": {
        "launch.bat": "says the switch is ignored, for anyone who still sets it",
        "cmd/gobbonet/launch.go": "drops a stale value from launch.bat's environment",
        "cmd/gobbonet/launch_test.go": "tests that",
        "AGENTS.md": "says what the name means now",
    },
}
HISTORY = ("docs/changelog/", "docs/archive/")
# Generated copies of files already listed: the staged web UI mirrors js/.
GENERATED = ("internal/webui/assets/", "dist/", "web/")
TEXT = {".go", ".js", ".mjs", ".py", ".sh", ".bat", ".ps1", ".nsi", ".md", ".txt",
        ".html", ".css", ".json", ".yml", ".yaml", ".toml", ".ini", ".spec", ""}


def shipped_files():
    """Tracked plus untracked-but-not-ignored files, or a walk outside git."""
    if (ROOT / ".git").exists():
        out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "--cached", "--others", "--exclude-standard"],
                             capture_output=True, text=True)
        if out.returncode == 0:
            return sorted(set(out.stdout.split("\n")) - {""})
    found = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for f in filenames:
            found.append(str(pathlib.Path(dirpath, f).relative_to(ROOT)).replace(os.sep, "/"))
    return sorted(found)


def main():
    files = [f for f in shipped_files() if (ROOT / f).is_file()]

    print("the file itself")
    check("fileserver.ps1 is not in the tree", not (ROOT / "fileserver.ps1").exists())
    mz = (ROOT / "scripts" / "make-zip.sh").read_text()
    check("the ZIP neither requires nor copies it", "fileserver" not in mz)
    nsi = (ROOT / "installer-win" / "gobbonet.nsi").read_text()
    check("the installer does not install it", 'File "${APPSRC}\\fileserver.ps1"' not in nsi)
    uninstall_at = nsi.find('Section "Uninstall"')
    delete = 'Delete "$INSTDIR\\fileserver.ps1"'
    first_delete = nsi.find(delete)
    check("the installer deletes a copy an older install left",
          0 <= first_delete < uninstall_at, (first_delete, uninstall_at))
    check("and the uninstaller still removes one", nsi.find(delete, uninstall_at) > uninstall_at)

    print("\nwho may still name it")
    for token, allowed in ALLOWED.items():
        stray = []
        for rel in files:
            if rel.startswith(HISTORY) or rel.startswith(GENERATED) or rel.startswith("tests/"):
                continue
            if pathlib.Path(rel).suffix.lower() not in TEXT:
                continue
            try:
                text = (ROOT / rel).read_bytes().decode("utf-8", errors="replace")
            except OSError:
                continue
            if token in text and rel not in allowed:
                stray.append(rel)
        check(f"{token}: only in the allowed places", not stray,
              "new mention(s): " + ", ".join(stray) + " -- remove it, or add the file to ALLOWED with a reason")
        missing = [rel for rel in allowed if not (ROOT / rel).is_file()]
        check(f"{token}: every allowed place still exists", not missing, missing)

    print("\nlaunch.bat")
    bat = (ROOT / "launch.bat").read_bytes().decode("latin-1")
    code = "\n".join(l for l in bat.split("\r\n")
                     if not l.strip().startswith("::") and not l.strip().lower().startswith("rem "))
    check("names no fileserver.ps1, even in comments", "fileserver" not in bat.lower())
    check("starts no PowerShell server", "start /min powershell" not in code)
    check("writes no active-model.json or models-list.json for one",
          '> "%~dp0active-model.json"' not in code and "-OutFile \"!MODELS_LIST_JSON!\"" not in code)
    check("has no minimise / restore window helpers (only the legacy monitor used them)",
          ":minimize_window" not in bat and ":restore_window" not in bat)

    print("\nsetup-lan.bat")
    lan = (ROOT / "setup-lan.bat").read_bytes().decode("latin-1")
    lan_code = "\n".join(l for l in lan.split("\r\n")
                         if not l.strip().startswith("::") and not l.strip().lower().startswith("rem "))
    check("makes no URL reservation", "http add urlacl" not in lan_code)
    check("removes the web port's old one", "call :drop_urlacl !WEB_PORT!" in lan_code)

    print("\nnothing deletes a user's copy behind their back")
    doctor = (ROOT / "cmd" / "gobbonet" / "doctor_leftover.go").read_text()
    check("gobbonet doctor only reports it", "os.Remove" not in doctor and "RemoveAll" not in doctor)
    js = (ROOT / "js" / "15-cards.js").read_text() + (ROOT / "js" / "22-scheduler.js").read_text()
    # The wording itself is pinned against the rendered text in
    # test-standdown-panel.mjs, test-lan-panel.mjs and test-version-stamp.mjs.
    check("the page's three notices name stop-gobbonet.bat, the fix",
          js.count("stop-gobbonet.bat") >= 3)

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
