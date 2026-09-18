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
    (':: STEP 3: START LLAMA-SERVER', 'server start'),
    (':: STEP 3c: EMBEDDING SERVER', 'the optional embedding server'),
    (':: STEP 5: FILE SERVER', 'the web server step'),
    (':: STEP 6: GET LAN IP + LAUNCH BROWSER', 'LAN address + browser'),
]:
    ok(at(marker) > 0, 'STEP present: %s' % what, 'missing marker: %s' % marker)

ok('Downloading llama.cpp' in SRC, 'the engine downloader is still in this window')
ok('prompt_yn' in SRC, 'it still asks yes/no questions rather than assuming')
ok('SECRET_FILE' in SRC, 'the password is still set here')

print('\n=== the steps are still in order ===')

order = [
    (':: STEP 1: CHECK FOR LLAMA-SERVER', 'engine'),
    (':: STEP 2: CHECK FOR MODEL GGUF', 'model'),
    (':: STEP 3: START LLAMA-SERVER', 'server'),
    (':: STEP 5: FILE SERVER', 'web'),
]
positions = [(at(m), name) for m, name in order]
ok(all(p > 0 for p, _ in positions), 'every ordered step was found')
ok(positions == sorted(positions), 'engine -> model -> server -> web, in that order',
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
ok(re.search(r'^"!GN!" --open --model', tail, re.M) is not None,
   'started directly, not with start /min',
   'a minimised window is how the engine output became invisible in the first place')
ok('start /min' not in tail.split(':launch_legacy')[0],
   'nothing in the handover block is minimised or detached')

print('\n=== gobbonet owns llama-server, so stand-down can work ===')

skip = at(':: WHO STARTS llama-server')
ok(skip > 0, 'the script steps aside from starting llama-server itself')
ok(skip < at(':start_server_legacy'),
   'and the old start is still there, below, as the fallback')
ok('goto :start_embed' in SRC,
   'while still reaching the embedding server step',
   'skipping too far would silently drop RAG')

print('\n=== the old path is still reachable ===')

ok('GOBBONET_LEGACY_SERVER' in SRC, 'an env var forces the legacy server')
ok(SRC.count(':start_server_legacy') >= 2 and SRC.count(':launch_legacy') >= 2,
   'both legacy labels are defined and jumped to')
ok(at('start /min powershell') > 0, 'fileserver.ps1 is still started on that path')
for label in ['start_server_legacy', 'launch_legacy']:
    goto_at = SRC.find('goto :' + label)
    label_at = SRC.find('\n:' + label)
    ok(goto_at > 0 and label_at > goto_at,
       ':%s is defined after the jump to it' % label)

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

if fails:
    print('\nFAILED: %d' % len(fails))
    for f in fails:
        print('  - ' + f)
    sys.exit(1)
print('\nall invariants hold')
