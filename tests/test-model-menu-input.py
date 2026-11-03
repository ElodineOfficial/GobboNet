"""launch.bat's model menu re-asks on bad input instead of closing -- issue #63.

THE BUG
-------
The first-run menu reads a number into MODEL_CHOICE and then tests it against
"1" through "10". Anything that matched none of them fell through every branch
to the [11] "add my own .gguf" path, which ends at :fatal. The prompt shown just
before the menu is "Download llama.cpp now? (Y/N)", so "y" was the natural thing
to type -- and it closed the window with "[FATAL] See the error above".

WHAT THIS RUNS
--------------
Not a Python re-telling of the fix. The block between `set "_MC_TRIES=0"` and
the VRAM safety net is lifted out of the real launch.bat and run through a
small interpreter for exactly the cmd subset it uses: set, set /p, set /a,
echo, goto/labels, `if [not] defined`, `if "a"=="b"`, `if N geq M`, `for %%N
in (...) do`, parenthesised if/else blocks and !delayed! expansion. Anything
outside that subset fails the test rather than being guessed at, so a later
edit that adds new syntax here has to extend this file on purpose.

`set /p` is modelled the way cmd does it: an empty line, or end of input,
leaves the variable as it was (here: undefined, because the line before clears
it). That is the property the existing ENTER-for-recommended default and the
EOF cap both depend on.

Run: python3 tests/test-model-menu-input.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = (ROOT / "launch.bat").read_bytes().decode("ascii")

passed = failed = 0


def ok(cond, label, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + label)
    else:
        failed += 1
        print("  ✗ " + label + ("\n      " + extra if extra else ""))


# --------------------------------------------------------------------------
# The block under test, straight out of launch.bat.
# --------------------------------------------------------------------------
lines = RAW.split("\r\n")
start = next((i for i, l in enumerate(lines) if l.strip() == 'set "_MC_TRIES=0"'), None)
end = next((i for i, l in enumerate(lines) if i > (start or 0) and l.startswith(":: VRAM safety net")), None)
if start is None or end is None:
    print("could not locate the model-choice block in launch.bat")
    sys.exit(1)
BLOCK = [l for l in lines[start:end] if l.strip() and not l.strip().startswith("::")]


# --------------------------------------------------------------------------
# A deliberately small cmd interpreter.
# --------------------------------------------------------------------------
class Goto(Exception):
    def __init__(self, label):
        self.label = label.lower()


class Unsupported(Exception):
    pass


def parse(src_lines):
    """Lines -> list of nodes. Blocks are ('if', cond, then, else) etc."""
    pos = 0

    def parse_block():
        nonlocal pos
        body = []
        while pos < len(src_lines):
            line = src_lines[pos].strip()
            if line == ")" or line.startswith(") else ("):
                return body
            pos += 1
            body.append(parse_stmt(line))
        return body

    def parse_stmt(line):
        nonlocal pos
        if line.startswith(":"):
            return ("label", line[1:].lower())
        m = re.match(r'^if (.*) \($', line)
        if m:
            then = parse_block()
            closer = src_lines[pos].strip()
            pos += 1
            other = None
            if closer.startswith(") else ("):
                other = parse_block()
                if src_lines[pos].strip() != ")":
                    raise Unsupported("unterminated else: " + src_lines[pos])
                pos += 1
            return ("if", m.group(1), then, other)
        return ("cmd", line)

    out = []
    while pos < len(src_lines):
        line = src_lines[pos].strip()
        pos += 1
        out.append(parse_stmt(line))
    return out


class Cmd:
    def __init__(self, env, inputs):
        self.env = {k.upper(): v for k, v in env.items()}
        self.inputs = list(inputs)   # None = end of input
        self.out = []
        self.prompts = 0

    def expand(self, s, loopvar=None):
        if loopvar:
            s = s.replace("%%" + loopvar[0], loopvar[1])
        # !VAR! -> value, undefined -> empty (delayed expansion)
        return re.sub(r"!([A-Za-z_][A-Za-z0-9_]*)!", lambda m: self.env.get(m.group(1).upper(), ""), s)

    def cond(self, c, lv):
        m = re.match(r"^not defined (\w+)$", c)
        if m:
            return m.group(1).upper() not in self.env
        m = re.match(r"^defined (\w+)$", c)
        if m:
            return m.group(1).upper() in self.env
        m = re.match(r'^(not )?"([^"]*)"=="([^"]*)"$', c)
        if m:
            eq = self.expand(m.group(2), lv) == self.expand(m.group(3), lv)
            return (not eq) if m.group(1) else eq
        m = re.match(r"^(\S+) geq (\S+)$", c)
        if m:
            return int(self.expand(m.group(1), lv)) >= int(self.expand(m.group(2), lv))
        raise Unsupported("condition: " + c)

    def simple(self, line, lv=None):
        # Single-line `if COND CMD`, possibly chained.
        m = re.match(r'^if (not defined \w+|defined \w+|(?:not )?"[^"]*"=="[^"]*") (.*)$', line)
        if m:
            if self.cond(m.group(1), lv):
                self.simple(m.group(2), lv)
            return
        m = re.match(r"^for %%(\w) in \(([^)]*)\) do (.*)$", line)
        if m:
            for item in m.group(2).split():
                self.simple(m.group(3), (m.group(1), item))
            return
        m = re.match(r'^set /p "(\w+)=(.*)"$', line)
        if m:
            self.prompts += 1
            if self.prompts > 50:
                raise RuntimeError("runaway prompt loop")
            got = self.inputs.pop(0) if self.inputs else None
            if got:                       # empty line or EOF: variable untouched
                self.env[m.group(1).upper()] = got
            return
        m = re.match(r"^set /a (\w+)\+=(\d+)$", line)
        if m:
            k = m.group(1).upper()
            self.env[k] = str(int(self.env.get(k, "0") or "0") + int(m.group(2)))
            return
        m = re.match(r'^set "(\w+)=(.*)"$', line)
        if m:
            val = self.expand(m.group(2), lv)
            if val:
                self.env[m.group(1).upper()] = val
            else:
                self.env.pop(m.group(1).upper(), None)
            return
        if line == "echo.":
            self.out.append("")
            return
        if line.startswith("echo "):
            self.out.append(self.expand(line[5:], lv))
            return
        m = re.match(r"^goto :?(\w+)$", line)
        if m:
            raise Goto(m.group(1))
        raise Unsupported("command: " + line)

    def run_nodes(self, nodes):
        for n in nodes:
            if n[0] == "label":
                continue
            if n[0] == "if":
                branch = n[2] if self.cond(n[1], None) else n[3]
                if branch:
                    self.run_nodes(branch)
                continue
            self.simple(n[1])

    def run(self, program):
        labels = {n[1]: i for i, n in enumerate(program) if n[0] == "label"}
        i = 0
        while True:
            try:
                self.run_nodes(program[i:])
                return
            except Goto as g:
                if g.label not in labels:
                    raise Unsupported("goto outside the block: " + g.label)
                i = labels[g.label]


PROGRAM = parse(BLOCK)


def menu(inputs, rec="0"):
    c = Cmd({"REC": rec}, inputs)
    c.run(PROGRAM)
    return c


def hints(c):
    return sum(1 for l in c.out if "not one of the choices" in l)


# --------------------------------------------------------------------------
print("\n=== the reporter's case: \"y\" at the menu ===")
c = menu(["y", "3"])
ok(c.env.get("MODEL_CHOICE") == "3", '"y" is not taken as an answer; the next one, 3, is',
   repr(c.env.get("MODEL_CHOICE")))
ok(hints(c) == 1, "and the user is told once that it was not a choice")
ok(c.prompts == 2, "by asking again, not by reprinting the menu or exiting")

print("\n=== every listed choice is accepted first time ===")
for n in range(1, 12):
    c = menu([str(n)])
    ok(c.env.get("MODEL_CHOICE") == str(n) and hints(c) == 0 and c.prompts == 1,
       f"[{n}] is accepted without a hint")

print("\n=== ENTER keeps its existing meaning ===")
c = menu([""], rec="5")
ok(c.env.get("MODEL_CHOICE") == "5" and hints(c) == 0, "ENTER takes the recommended pick")
c = menu(["", "2"], rec="0")
ok(c.env.get("MODEL_CHOICE") == "2" and hints(c) == 1,
   "with no recommendation, ENTER is asked again rather than exiting")
c = menu(["nope", ""], rec="4")
ok(c.env.get("MODEL_CHOICE") == "4", "after a bad answer, ENTER still takes the recommendation")
ok(any("recommended pick [4]" in l for l in c.out), "and the hint names the recommended number")
c = menu(["nope", "1"], rec="0")
ok(not any("recommended pick" in l for l in c.out), "the hint does not offer ENTER when there is no recommendation")

print("\n=== the six added in 1.7.9 are answers too ===")
for good in ["12", "13", "14", "15", "16", "17"]:
    c = menu([good])
    ok(c.env.get("MODEL_CHOICE") == good and hints(c) == 0, f"{good!r} is taken first time")

print("\n=== things that are not 1-17 ===")
for bad in ["Y", "yes", "n", "0", "18", "3a", " 3", "3 ", "-1", "1.5", "ten", "11 "]:
    c = menu([bad, "7"])
    ok(c.env.get("MODEL_CHOICE") == "7" and hints(c) == 1, f"{bad!r} is asked again")

print("\n=== no console behind it (input at EOF) ===")
c = menu([None] * 100, rec="0")
ok(c.prompts == 5, "gives up after 5 tries instead of looping forever", f"prompts={c.prompts}")
ok(c.env.get("MODEL_CHOICE") == "11", "and takes the same [11] path the old code always took")
ok(any("Still no valid choice" in l for l in c.out), "saying why")
c = menu([None], rec="6")
ok(c.env.get("MODEL_CHOICE") == "6" and c.prompts == 1, "with a recommendation, EOF still takes it, as before")
c = menu(["y"] * 4 + ["2"], rec="0")
ok(c.env.get("MODEL_CHOICE") == "2", "four bad answers then a good one still gets the good one")

print("\n=== the block around it ===")
src_block = "\r\n".join(lines[start:end])
for i, n in enumerate(list(range(1, 11)) + list(range(12, 18)), 1):
    ok(re.search(r'^if "!MODEL_CHOICE!"=="%d" \(\r?$' % n, RAW, re.M) is not None,
       f"[{n}] still has its download branch")
ok(re.search(r'^if "!MODEL_CHOICE!"=="11"', RAW, re.M) is None,
   "[11] still has no branch of its own (it is the fall-through)")
inside_blocks = [l for l in BLOCK if l.startswith(" ") and l.strip().startswith("echo")]
ok(all("(" not in l and ")" not in l for l in inside_blocks),
   "no echo inside a ( ) block carries a parenthesis (cmd would end the block there)")
ok(re.search(r"(?i)setlocal\s+enabledelayedexpansion", RAW) is not None,
   "delayed expansion is on, which the !VAR! reads inside the block rely on")
ok(RAW.count("\n") == RAW.count("\r\n"), "launch.bat is still CRLF throughout")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
