"""One llama.cpp pin: launch.bat reads engine.sha256 like everything else (#63).

engine.sha256 says it is "the build BOTH installers bundle", and build-deb.sh,
build-rpm.sh, and `gobbonet engine install` (installer/build-installer.sh until 1.7.9)
(internal/engine) all read it. launch.bat carried its own pin instead, and the
two drifted: Linux shipped b10456 while every Windows first run downloaded
b9294. The Windows installer did not even install engine.sha256, so on an
installed copy `gobbonet engine install` could not find a pin at all.

This checks that launch.bat now takes its tag and hash from engine.sha256 --
by emulating the exact `for /f` it uses over the real file -- that its fallback
for older installs is the same pin, that every reader agrees on the Windows
asset name, and that the file actually reaches an installed copy and the ZIP.

Run: python3 tests/test-engine-pin.py
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
passed = failed = 0


def ok(cond, label, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + label)
    else:
        failed += 1
        print("  ✗ " + label + ("\n      " + str(extra) if extra else ""))


raw_pin = (ROOT / "engine.sha256").read_text()
PIN = dict(l.split("=", 1) for l in raw_pin.splitlines() if l and not l.startswith("#") and "=" in l)
BUILD, WIN_SHA = PIN.get("LLAMA_BUILD", ""), PIN.get("WIN_GPU_SHA256", "")
LAUNCH = (ROOT / "launch.bat").read_bytes().decode("ascii")
LINES = LAUNCH.split("\r\n")


def cmd_for_f(text, eol, delims, keys):
    """cmd's `for /f "eol=E tokens=1,* delims=D"` over a file, then the
    `if /i "%%K"=="KEY" set "VAR=%%L"` lines: returns {KEY: value}.

    for /f splits the file on LF and drops the CR of a CRLF line, skips empty
    lines and lines starting with the eol character, skips leading delimiters,
    takes token 1 up to the next delimiter run, and gives `*` the rest of the
    line after that run."""
    out = {}
    for line in text.split("\n"):
        line = line[:-1] if line.endswith("\r") else line
        if not line or line.startswith(eol):
            continue
        s = line.lstrip(delims)
        m = re.match(r"([^%s]*)[%s]+(.*)" % (re.escape(delims), re.escape(delims)), s)
        k, rest = (m.group(1), m.group(2)) if m else (s, "")
        for key in keys:
            if k.lower() == key.lower():
                out[key] = rest
    return out


print("\n=== launch.bat takes its pin from engine.sha256 ===")
ok(BUILD and re.fullmatch(r"[0-9a-f]{64}", WIN_SHA), "engine.sha256 names a build and a Windows SHA-256", (BUILD, WIN_SHA))
loop = next((l for l in LINES if "%~dp0engine.sha256" in l and l.lstrip().startswith("for /f")), "")
opts = re.search(r'for /f "([^"]*)"', loop)
ok(opts is not None, "launch.bat reads engine.sha256 with for /f", loop)
if opts:
    o = opts.group(1)
    eol = re.search(r"eol=(\S)", o).group(1)
    delims = re.search(r"delims=(.)", o).group(1)
    ok("tokens=1,*" in o and "usebackq" in o, "tokens=1,* and usebackq, so the hash and a quoted path parse", o)
    keymap = dict(re.findall(r'if /i "%%K"=="(\w+)" set "(\w+)=%%L"', LAUNCH))
    ok(keymap == {"LLAMA_BUILD": "LLAMA_PIN_TAG", "WIN_GPU_SHA256": "LLAMA_PIN_SHA256"},
       "LLAMA_BUILD -> LLAMA_PIN_TAG and WIN_GPU_SHA256 -> LLAMA_PIN_SHA256", keymap)
    for name, text in (("as committed", raw_pin), ("with CRLF line endings", raw_pin.replace("\n", "\r\n"))):
        got = cmd_for_f(text, eol, delims, keymap.keys())
        ok(got.get("LLAMA_BUILD") == BUILD and got.get("WIN_GPU_SHA256") == WIN_SHA,
           f"emulated over the real engine.sha256 ({name}) it yields {BUILD} and its hash", got)

fallback = dict(re.findall(r'^\s+set "(LLAMA_PIN_TAG|LLAMA_PIN_SHA256)=([^"!%]+)"\r?$', LAUNCH, re.M))
ok(fallback == {"LLAMA_PIN_TAG": BUILD, "LLAMA_PIN_SHA256": WIN_SHA},
   "the fallback for installs without engine.sha256 is the same pin", fallback)
literal = [l for l in LINES if re.match(r'\s*set "LLAMA_PIN_(TAG|SHA256)=[^"!%]', l)]
ok(len(literal) == 2 and all(l.startswith("    ") for l in literal),
   "no other literal pin anywhere in launch.bat (only the indented fallback)", literal)
guard = LAUNCH.find('if exist "%~dp0engine.sha256" (')
els = LAUNCH.find(") else (", guard)
ok(guard != -1 and guard < LAUNCH.find('for /f "usebackq eol=#') < els < LAUNCH.find(f'set "LLAMA_PIN_TAG={BUILD}"'),
   "the fallback applies only when engine.sha256 is absent (a present file missing a key fails closed)")
ok("WIN_GPU_SHA256=!LLAMA_ACTUAL!" in LAUNCH and 'set "LLAMA_PIN_SHA256=!LLAMA_ACTUAL!"' not in LAUNCH,
   "the unpinned-download hint says to pin in engine.sha256, not launch.bat")
ok(LAUNCH.count("\n") == LAUNCH.count("\r\n"), "launch.bat is still CRLF throughout")

print("\n=== every reader agrees on the Windows asset ===")
want = f"llama-{BUILD}-bin-win-vulkan-x64.zip"
la = re.search(r'set "LLAMA_ASSET=llama-!LLAMA_PIN_TAG!(-bin-win-vulkan-x64\.zip)"', LAUNCH)
go = (ROOT / "internal" / "engine" / "engine.go").read_text()
ok(la and f"llama-{BUILD}{la.group(1)}" == want, f"launch.bat downloads {want}")
ok('"llama-"+build+"-bin-win-vulkan-x64.zip", "WIN_GPU_SHA256"' in go, "gobbonet engine install fetches the same asset with the same key")
ok(not (ROOT / "installer").exists(), "the retired installer/ design is gone (1.7.9), so it cannot name a different asset")

print("\n=== engine.sha256 reaches every Windows copy ===")
nsi = (ROOT / "installer-win" / "gobbonet.nsi").read_text()
ok('File "${APPSRC}\\engine.sha256"' in nsi, "the Windows installer installs it beside launch.bat and gobbonet.exe")
ok('Delete "$INSTDIR\\engine.sha256"' in nsi, "and its uninstaller removes it")
ok("`engine.sha256`" in (ROOT / "installer-win" / "README.md").read_text(), "installer-win/README.md lists it for staging")
mz = (ROOT / "scripts" / "make-zip.sh").read_text()
ok(re.search(r"^engine\.sha256$", mz, re.M) is not None, "make-zip.sh requires it in the ZIP")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
