#!/usr/bin/env python3
"""1.7.9 Tekken fix: a built-in chat template NAME must travel with --no-jinja.

The pinned llama.cpp (b10456) runs llama-server with Jinja ON by default, and
with Jinja on it reads --chat-template as Jinja source. "mistral-v7-tekken"
then renders as that literal text for every request, so the model only sees
the word "tekken".

Up to 1.7.9 two command lines carried the fix: launch.bat's own llama-server
start and Go's BuildArgs. 1.8.0 removed the batch one -- gobbonet.exe starts
the chat model -- so the rule is pinned in Go
(internal/supervisor/template_args_test.go), and this file checks that
launch.bat did not keep a half-copy that could drift from it.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
bat = (ROOT / "launch.bat").read_bytes().decode("latin-1")
code = "\n".join(l for l in bat.split("\r\n")
                 if not l.strip().startswith("::") and not l.strip().lower().startswith("rem "))
go_test = (ROOT / "internal" / "supervisor" / "template_args_test.go").read_text()
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  PASS    " if ok else "  FAIL    ") + name)
    if not ok:
        failures += 1
        if detail:
            print("        " + detail)


check("the old tekken -> mistral-v7 rewrite is gone",
      not re.search(r'set "MODEL_CHAT_TEMPLATE=mistral-v7"', bat),
      "it brought back issue #20's [INST] spacing")
check("launch.bat builds no template flags of its own (1.8.0)",
      "JINJA_FLAG" not in code and "CHAT_TEMPLATE_FLAG" not in code,
      "gobbonet.exe chooses them; a second copy here is the drift this file guards")
for name in ("TestBuiltinTemplateNameAlwaysTravelsWithNoJinja", "TestEmbeddedTemplateKeepsJinja",
             "TestSidecarTemplateFileKeepsJinja", "TestJinjaStateIsAlwaysExplicit"):
    check(f"the Go side is pinned: {name}", f"func {name}(" in go_test)
check("launch.bat is still CRLF throughout",
      "\n" not in bat.replace("\r\n", ""))

print("\n%s" % ("all passed" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
