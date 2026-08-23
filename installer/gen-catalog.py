#!/usr/bin/env python3
"""
Generate installer/models.ini from launch.bat.

launch.bat is the single source of truth for the model catalogue. It holds
that catalogue in three separate places:

  1. the menu text          (echo lines: display name, quant, approximate size)
  2. the recommendation map ($min table plus the vram -> pick ladder, in
                             hw-recommend.ps1 beside launch.bat -- upstream
                             1.6.0 moved these out of an inline PowerShell
                             one-liner, because a kilobyte of semicolon-chained
                             -Command reads to antivirus like payload staging)
  3. the download ladder    (if "!MODEL_CHOICE!"=="N" blocks: repo, file,
                             context size, kv cache type)

The installer needs all three. Hand-copying them into NSIS would fork the
catalogue the first time a quant is bumped, so we parse them out instead and
emit one INI that NSIS reads natively with ReadINIStr -- no JSON plugin, no
second copy to keep in sync.

If launch.bat's shape changes enough that a field stops parsing, this script
fails loudly rather than emitting a catalogue with holes in it. A silently
half-parsed catalogue would mean an installer that offers a model it cannot
download.

Usage:  ./gen-catalog.py ../launch.bat models.ini
        (hw-recommend.ps1 is read from launch.bat's own directory)
"""

import os
import re
import sys
from collections import OrderedDict


def die(msg):
    sys.stderr.write("gen-catalog: ERROR: %s\n" % msg)
    sys.exit(1)


def parse_ladder(text):
    """Extract the per-choice download blocks keyed by menu number."""
    entries = OrderedDict()
    pattern = re.compile(
        r'if\s+"!MODEL_CHOICE!"=="(\d+)"\s*\((.*?)^\)',
        re.DOTALL | re.MULTILINE,
    )
    for match in pattern.finditer(text):
        idx = int(match.group(1))
        body = match.group(2)
        fields = dict(re.findall(r'set\s+"([A-Z_]+)=([^"]*)"', body))
        missing = [k for k in ("DL_REPO", "DL_FILE", "MODEL_DISPLAY") if k not in fields]
        if missing:
            die("choice %d is missing %s in its download block" % (idx, ", ".join(missing)))
        entries[idx] = fields
    if not entries:
        die("found no `if \"!MODEL_CHOICE!\"==\"N\" (` download blocks -- "
            "launch.bat's ladder shape has changed")
    return entries


def parse_sizes(text):
    """Approximate on-disk size per menu number, from the catalogue echo lines."""
    sizes = {}
    for idx, size in re.findall(r'echo\s+\[\s*(\d+)\]\s+.*?~\s*([0-9.]+)\s*GB', text):
        sizes[int(idx)] = size
    return sizes


def parse_min_vram(text):
    """The $min hashtable in hw-recommend.ps1."""
    match = re.search(r'\$min\s*=\s*@\{([^}]*)\}', text)
    if not match:
        die("could not find the $min=@{...} VRAM table in hw-recommend.ps1")
    return {int(k): int(v) for k, v in re.findall(r'(\d+)\s*=\s*(\d+)', match.group(1))}


def parse_pick_min(text):
    """
    launch.bat's own copy of the VRAM gate: `if "!MODEL_CHOICE!"=="N" set
    "PICK_MIN=V"`. It exists separately from $min because one is read by batch
    and the other by PowerShell, and hw-recommend.ps1 says in as many words
    that the two must agree.

    Cross-checking them here costs one regex and catches the failure the split
    invites: a catalogue change edited in one place, so the menu warns about a
    threshold the download does not enforce -- or the reverse. The installer
    replays $min, so a drift is a warning our wizard shows that the launcher
    disagrees with.
    """
    return {int(idx): int(vram) for idx, vram in
            re.findall(r'if\s+"!MODEL_CHOICE!"=="(\d+)"\s+set\s+"PICK_MIN=(\d+)"', text)}


def parse_recommend(text):
    """
    The vram -> menu-number ladder, e.g.
      if($t -eq 'cpu_only'){ $rec=2 } elseif($v -ge 16){ $rec=5 } ... else { $rec=2 }
    Returned in evaluation order; NSIS replays it with integer compares.
    """
    rungs = [(int(v), int(r)) for v, r in
             re.findall(r'\$v\s+-ge\s+(\d+)\s*\)\s*\{\s*\$rec\s*=\s*(\d+)', text)]
    if not rungs:
        die("could not parse the VRAM recommendation ladder")

    cpu_match = re.search(r"\$t\s+-eq\s+'cpu_only'\s*\)\s*\{\s*\$rec\s*=\s*(\d+)", text)
    if not cpu_match:
        die("could not find the cpu_only recommendation")

    else_match = re.search(r'else\s*\{\s*\$rec\s*=\s*(\d+)\s*\}', text)
    if not else_match:
        die("could not find the fallback (else) recommendation")

    return rungs, int(cpu_match.group(1)), int(else_match.group(1))


def main():
    if len(sys.argv) != 3:
        sys.stderr.write(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    with open(src, "r", encoding="utf-8", errors="replace") as handle:
        text = handle.read()

    # The recommendation half of the catalogue lives beside launch.bat rather
    # than inside it since 1.6.0. Resolve it from launch.bat's directory so the
    # command line stays what build-installer.sh already passes.
    rec_src = os.path.join(os.path.dirname(os.path.abspath(src)), "hw-recommend.ps1")
    if not os.path.exists(rec_src):
        die("hw-recommend.ps1 is not next to %s. It holds the $min VRAM table "
            "and the recommendation ladder; without it this catalogue would "
            "ship with no VRAM warnings at all." % src)
    with open(rec_src, "r", encoding="utf-8", errors="replace") as handle:
        rec_text = handle.read()

    entries = parse_ladder(text)
    sizes = parse_sizes(text)
    min_vram = parse_min_vram(rec_text)
    rungs, cpu_only_pick, default_pick = parse_recommend(rec_text)

    # Two hand-maintained copies of the same gate, in two languages. Upstream
    # says they must agree; nothing enforced it, and slots 9 and 10 sat with no
    # PICK_MIN at all until 1.6.0 -- so the launcher downloaded a 19 GB model to
    # an 8 GB card without a word while the menu marked it as too big.
    pick_min = parse_pick_min(text)
    drift = sorted(idx for idx in set(min_vram) & set(pick_min)
                   if min_vram[idx] != pick_min[idx])
    if drift:
        die("hw-recommend.ps1 and launch.bat disagree about the VRAM gate for "
            "slot(s) %s: %s. The menu would warn at one threshold and the "
            "download refuse at another." % (
                ", ".join(str(i) for i in drift),
                "; ".join("%d: $min=%d PICK_MIN=%d" % (i, min_vram[i], pick_min[i])
                          for i in drift)))
    ungated = sorted(set(min_vram) - set(pick_min))
    if ungated:
        die("slot(s) %s are in the $min table but have no PICK_MIN line in "
            "launch.bat, so nothing warns before the download starts."
            % ", ".join(str(i) for i in ungated))

    out = []
    out.append("; GENERATED by installer/gen-catalog.py -- do not edit by hand.")
    out.append("; Source of truth: launch.bat. Re-run the generator after changing it.")
    out.append("")
    out.append("[catalog]")
    out.append("count=%d" % len(entries))
    # NSIS iterates 1..max and skips gaps, because launch.bat's menu numbering
    # is display-ordered rather than contiguous.
    out.append("max_index=%d" % max(entries))
    out.append("")

    out.append("[recommend]")
    out.append("rungs=%d" % len(rungs))
    for n, (vram, pick) in enumerate(rungs, start=1):
        out.append("rung%d_vram=%d" % (n, vram))
        out.append("rung%d_pick=%d" % (n, pick))
    out.append("cpu_only=%d" % cpu_only_pick)
    out.append("default=%d" % default_pick)
    out.append("")

    for idx, fields in sorted(entries.items()):
        if idx not in sizes:
            die("choice %d has a download block but no menu line to read its "
                "size from" % idx)
        if idx not in min_vram:
            die("choice %d is absent from the $min VRAM table" % idx)
        out.append("[%d]" % idx)
        out.append("display=%s" % fields["MODEL_DISPLAY"])
        out.append("repo=%s" % fields["DL_REPO"])
        out.append("file=%s" % fields["DL_FILE"])
        out.append("size_gb=%s" % sizes[idx])
        # NSIS compares integers only: it would read "4.7" as 4 and under-book
        # the disk check by most of a gigabyte. Round up here so the wizard has
        # a whole number that errs toward asking for more space, not less.
        out.append("size_gb_int=%d" % -(-float(sizes[idx]) // 1))
        out.append("min_vram=%d" % min_vram[idx])
        out.append("ctx=%s" % fields.get("CTX_SIZE", "16384"))
        out.append("kv=%s" % fields.get("KV_CACHE_TYPE", "q8_0"))
        out.append("")

    with open(dst, "w", encoding="utf-8", newline="\r\n") as handle:
        handle.write("\n".join(out))

    sys.stderr.write("gen-catalog: wrote %s (%d models)\n" % (dst, len(entries)))


if __name__ == "__main__":
    main()
