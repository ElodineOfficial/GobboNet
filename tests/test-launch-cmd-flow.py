#!/usr/bin/env python3
"""Windows keeps its CMD window. Linux keeps its HTML wizard.

WHY THIS FILE EXISTS

The two platforms onboard differently, on purpose:

    Linux    launch options are answered in a browser -- gobbonet-setup.py
             serves wizard.html and the questions happen there.
    Windows  launch options are answered in the CMD window -- launch.bat asks
             for the password, fetches the engine, probes the hardware, offers
             a model menu and checks what it downloaded, all on screen.

1.7.5 briefly broke that. A handoff added at the TOP of launch.bat jumped over
the entire Windows flow and ran `gobbonet setup` -- which serves the HTML
wizard. Windows was handed the Linux experience, and every question that used
to be asked in the green window stopped being asked there at all.

So what this pins is the SHAPE of the Windows flow, not just the handover: the
steps are present, in order, and the handover to gobbonet.exe happens AFTER the
questions rather than instead of them.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'launch.bat').read_text(encoding='utf-8', errors='replace')

fails = []


def ok(cond, label, extra=''):
    if cond:
        print('  ✓ ' + label)
    else:
        fails.append(label)
        print('  ✗ ' + label + (('\n      ' + extra) if extra else ''))


def at(needle):
    """Position of a marker, or -1."""
    return SRC.find(needle)


print('\n=== the CMD window still asks everything it used to ===')

# Each of these is a thing the user SEES AND ANSWERS in the window. If any goes
# missing, the Windows onboarding has been replaced rather than extended.
for marker, what in [
    (':: STEP 1: CHECK FOR LLAMA-SERVER', 'engine check/download'),
    (':: STEP 2: CHECK FOR MODEL GGUF', 'model check'),
    (':: MODEL DOWNLOAD MENU', 'the model menu'),
    (':: HARDWARE-AWARE MODEL SUGGESTION', 'hardware-aware recommendation'),
    (':: INTEGRITY CHECK', 'downloaded-model checksum'),
    (':: STEP 3: LLAMA-SERVER (gobbonet.exe starts it)', 'the server step'),
    (':: STEP 3c: EMBEDDING MODEL', 'the optional embedding model download'),
    (':: STEP 5: HAND OVER TO gobbonet.exe', 'the hand-over'),
]:
    ok(at(marker) > 0, 'STEP present: %s' % what, 'missing marker: %s' % marker)

ok('Downloading llama.cpp' in SRC, 'the engine downloader is still in this window')
ok('prompt_yn' in SRC, 'it still asks yes/no questions rather than assuming')
ok('SECRET_FILE' in SRC, 'the password is still set here')

print('\n=== the steps are still in order ===')

order = [
    (':: STEP 1: CHECK FOR LLAMA-SERVER', 'engine'),
    (':: STEP 2: CHECK FOR MODEL GGUF', 'model'),
    (':: STEP 3: LLAMA-SERVER (gobbonet.exe starts it)', 'server'),
    (':: STEP 5: HAND OVER TO gobbonet.exe', 'hand-over'),
]
positions = [(at(m), name) for m, name in order]
ok(all(p > 0 for p, _ in positions), 'every ordered step was found')
ok(positions == sorted(positions), 'engine -> model -> server -> hand-over, in that order',
   'got: %s' % [n for _, n in sorted(positions)])

print('\n=== the handover happens AFTER the questions, not instead of them ===')

handover = at(':: HAND THE SERVER ROLE TO gobbonet.exe')
ok(handover > 0, 'launch.bat hands the server role to gobbonet.exe')
ok(handover > at(':: STEP 2: CHECK FOR MODEL GGUF'),
   'and does so after the model menu, not before it',
   'a handover above the questions is what replaced the Windows flow with the '
   'Linux wizard in the first place')
ok(handover > at(':: STEP 1: CHECK FOR LLAMA-SERVER'),
   'and after the engine download, so that capability is not skipped')

# The specific mistake: never send a Windows user into the browser wizard.
ok('setup --status' not in SRC and '" setup' not in SRC,
   'it never runs `gobbonet setup` -- that is the Linux HTML wizard',
   'Windows answers its questions in this window')

print('\n=== the handover carries the answers it just collected ===')

for key in ['server_exe', 'model_dir', 'ctx_size', 'gpu_layers', 'kv_cache_type',
            'listen_port', 'llm_url', 'access_secret']:
    ok(re.search(r'config set\s+%s\b' % key, SRC) is not None,
       'passes %s' % key)

ok('--model' in SRC,
   'and names the model the menu chose',
   'letting the server pick the first file it scans makes STEP 2 decorative')
ok(re.search(r'config set\s+access_secret\s+"!ACCESS_SECRET!"', SRC) is not None,
   'the password set above is reused, not asked again')

print('\n=== gobbonet runs IN this window ===')

tail = SRC[handover:]
# !GN_OPEN! is --open unless open_browser = false (1.8.0, PR #58).
ok(re.search(r'^"!GN!" !GN_OPEN! --model', tail, re.M) is not None,
   'started directly, not with start /min',
   'a minimised window is how the engine output became invisible in the first place')
ok('start /min' not in tail,
   'nothing in the handover block is minimised or detached')

print('\n=== gobbonet owns llama-server, so stand-down can work ===')

skip = at(':: STEP 3: LLAMA-SERVER (gobbonet.exe starts it)')
ok(skip > 0, 'the script leaves starting llama-server to gobbonet.exe')
code = '\n'.join(l for l in SRC.splitlines()
                 if not l.strip().startswith('::') and not l.strip().lower().startswith('rem '))
chat_start = [l for l in code.splitlines() if '!SERVER_EXE!' in l and '--model' in l and '--embeddings' not in l]
ok(not chat_start, 'and writes no chat llama-server command line of its own', chat_start)
ok(':start_embed' in SRC and SRC.find('\n:start_embed') < SRC.find('\n:launch'),
   'while still reaching the embedding model step before the hand-over',
   'skipping too far would leave a first run with no embedding model')
ok(not any('--embeddings' in l or 'start /min' in l for l in code.splitlines()),
   'and starts no embedding server: gobbonet.exe does (1.8.0, #15)')

print('\n=== the legacy server is gone (1.8.0) ===')

for gone in (':start_server_legacy', ':launch_legacy', ':monitor_loop', ':http_probe', ':llm_state',
             'fileserver.ps1', 'start /min powershell'):
    ok(gone not in SRC, 'no %s left' % gone)
legacy_lines = [l.strip() for l in code.splitlines() if 'GOBBONET_LEGACY_SERVER' in l]
ok(len(legacy_lines) == 2 and legacy_lines[0] == 'if defined GOBBONET_LEGACY_SERVER (' and
   legacy_lines[1].startswith('echo') and 'ignored' in code[code.find(legacy_lines[1]):][:300],
   'GOBBONET_LEGACY_SERVER only gets the note that it is ignored', legacy_lines)
missing = at('if not exist "%~dp0gobbonet.exe" goto :no_gobbonet_exe')
ok(0 < missing < at(':: SECURITY -- access password'),
   'a missing gobbonet.exe stops the run before the password prompt',
   'answering every question only to find nothing to hand them to is the 1.7.9 trap')
ok(SRC.count('goto :no_gobbonet_exe') == 2,
   'and is checked again right before the hand-over (antivirus can take it mid-run)')
ok(SRC.find('\n:no_gobbonet_exe') > 0 and 'goto :fatal' in SRC[SRC.find('\n:no_gobbonet_exe'):SRC.find('\n:fatal')],
   'the message ends at :fatal, so the window stays open to be read')

print('\n=== the .bat files are still CRLF ===')

# Batch files ship with Windows line endings. An editing pass flattened
# launch.bat to LF once already -- Python translates newlines on read and
# writes the platform's on the way out -- and the only thing that noticed was
# an unrelated test that splits on \r\n.
for bat in sorted(ROOT.glob('*.bat')):
    raw = bat.read_bytes()
    crlf = raw.count(b'\r\n')
    lone = raw.count(b'\n') - crlf
    ok(crlf > 0 and lone == 0, '%s uses CRLF throughout' % bat.name,
       'CRLF=%d lone LF=%d' % (crlf, lone))

print('\n=== no literal ! in a delayed-expansion script ===')

# With EnableDelayedExpansion on, cmd treats every ! as the edge of a variable.
# "echo  [!] Found !N! rules" printed "[N rules", and "All done!" lost its !.
# Only !NAME! (and !NAME:...!) forms are allowed in code lines.
for bat in sorted(ROOT.glob('*.bat')):
    text = bat.read_bytes().decode('latin-1')
    if 'EnableDelayedExpansion' not in text:
        continue
    stray = []
    for n, line in enumerate(text.split('\r\n'), 1):
        t = line.strip()
        if t.startswith('::') or t.lower().startswith('rem') or '!' not in t:
            continue
        rest = re.sub(r'![A-Za-z_][A-Za-z0-9_]*(:[^!]*)?!', '', t)
        rest = re.sub(r'!GGUF_CHOICE_%[A-Za-z_]+%!', '', rest)
        if '!' in rest:
            stray.append('%d: %s' % (n, t[:70]))
    ok(not stray, '%s has no literal ! that delayed expansion would eat' % bat.name, stray)

if fails:
    print('\nFAILED: %d' % len(fails))
    for f in fails:
        print('  - ' + f)
    sys.exit(1)
print('\nall invariants hold')
