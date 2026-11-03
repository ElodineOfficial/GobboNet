#!/usr/bin/env python3
"""1.7.9 Tekken fix: a built-in chat template NAME must travel with --no-jinja.

The pinned llama.cpp (b10456) runs llama-server with Jinja ON by default, and
with Jinja on it reads --chat-template as Jinja source. "mistral-v7-tekken"
then renders as that literal text for every request, so the model only sees
the word "tekken". Go's side is covered by
internal/supervisor/template_args_test.go; this pins launch.bat's side, which
can only be checked statically from Linux.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
bat = (ROOT / "launch.bat").read_bytes().decode("latin-1")
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  PASS    " if ok else "  FAIL    ") + name)
    if not ok:
        failures += 1
        if detail:
            print("        " + detail)


# The flag block between the two "set" resets and the launcher write.
start = bat.index('set "JINJA_FLAG="')
end = bat.index(":: Write a small launcher script")
block = bat[start:end]

check("the old tekken -> mistral-v7 rewrite is gone",
      not re.search(r'set "MODEL_CHAT_TEMPLATE=mistral-v7"', bat),
      "it brought back issue #20's [INST] spacing")
name_branch = re.search(
    r'if not "!MODEL_CHAT_TEMPLATE!"=="" \(\r\n(.*?)\r\n    \)', block, re.S)
check("a template-name branch exists", name_branch is not None)
if name_branch:
    body = name_branch.group(1)
    check("the name branch forces --no-jinja",
          'set "JINJA_FLAG=--no-jinja"' in body, body)
    check("the name branch still sets --chat-template",
          "--chat-template !MODEL_CHAT_TEMPLATE!" in body, body)
check("Jinja off is stated, not left to the engine default",
      'else (set "JINJA_FLAG=--no-jinja")' in block)
check("file templates keep --jinja",
      block.count('set "JINJA_FLAG=--jinja"') >= 2)
check("launch.bat is still CRLF throughout",
      "\n" not in bat.replace("\r\n", ""))

print("\n%s" % ("all passed" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
