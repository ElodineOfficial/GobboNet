#!/usr/bin/env python3
"""
Pin a SHA-256 on every model in the catalogue (1.7.9, F2).

A pinned hash is the catalogue's own record of what each file should be. It
is written once, here, by whoever maintains the catalogue, and then shipped.
At download time GobboNet checks the file against it, so a file that changes
on HuggingFace after it was pinned is refused rather than trusted. Entries
without a pin still download, checked against HuggingFace's own record only,
and the Add a Model window marks them UNVERIFIED and asks twice.

The hash comes from the file's LFS pointer:
    https://huggingface.co/<repo>/raw/main/<file>
which reads "oid sha256:<64 hex>" and "size <bytes>". That is the same
record the downloader falls back to, read at pinning time instead of at
download time -- which is the whole point.

What it does to launch.bat (the source of truth; catalog/gen-catalog.py turns
it into models.ini):

  default   adds  set "DL_SHA256=<hex>"  to every download block without one
  --check   fetches every pointer and compares it with every pin already
            there; changes nothing; exits 1 on any mismatch or failure
  --dry-run prints what default would write, writes nothing

After writing it regenerates catalog/models.ini and its copy in linux-amd64/,
unless --no-regen. Then review `git diff` and commit.

It also catches a wrong entry: a repo or file that does not exist answers
404, and a pointer whose size is far from the size the menu advertises is
reported (a typo'd quant, usually).

Usage:  python3 catalog/pin-hashes.py [--check] [--dry-run] [--no-regen]
        (run from anywhere; finds launch.bat beside catalog/)

Offline testing: GOBBONET_PIN_FIXTURE=<file.json> maps each pointer URL to the
text it should return (or to null for a 404). tests/test-pin-hashes.py uses it.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BLOCK_RE = re.compile(r'(if\s+"!MODEL_CHOICE!"=="(\d+)"\s*\()(.*?)(^\))', re.DOTALL | re.MULTILINE)
FIELD_RE = re.compile(r'set\s+"([A-Z0-9_]+)=([^"]*)"')
SIZE_RE = re.compile(r'echo\s+\[\s*(\d+)\]\s+.*?~\s*([0-9.]+)\s*GB')
OID_RE = re.compile(r'^oid sha256:([0-9a-f]{64})\s*$', re.MULTILINE)
PTR_SIZE_RE = re.compile(r'^size (\d+)\s*$', re.MULTILINE)


def pointer_url(repo, file):
    return "https://huggingface.co/%s/raw/main/%s" % (repo, file)


def fetch(url):
    """The pointer's text, or None for a 404. Raises on anything else."""
    fixture = os.environ.get("GOBBONET_PIN_FIXTURE")
    if fixture:
        with open(fixture, encoding="utf-8") as f:
            table = json.load(f)
        if url not in table:
            raise RuntimeError("no fixture for " + url)
        return table[url]
    req = urllib.request.Request(url, headers={"User-Agent": "GobboNet catalogue pinning"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read(64 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def read_pointer(text):
    """(sha256, size) from an LFS pointer, or (None, None) if it is not one."""
    m = OID_RE.search(text or "")
    s = PTR_SIZE_RE.search(text or "")
    return (m.group(1) if m else None, int(s.group(1)) if s else None)


def main(argv):
    check = "--check" in argv
    dry = "--dry-run" in argv
    regen = "--no-regen" not in argv and not check and not dry
    bat_path = os.path.join(ROOT, "launch.bat")
    raw = open(bat_path, "rb").read()
    crlf = b"\r\n" in raw
    text = raw.decode("ascii").replace("\r\n", "\n")
    sizes = {int(i): float(gb) for i, gb in SIZE_RE.findall(text)}

    problems, changes = [], 0
    out, last = [], 0
    for m in BLOCK_RE.finditer(text):
        idx, body = int(m.group(2)), m.group(3)
        fields = dict(FIELD_RE.findall(body))
        repo, file = fields.get("DL_REPO"), fields.get("DL_FILE")
        name = "[%d] %s" % (idx, fields.get("MODEL_DISPLAY", file))
        if not repo or not file:
            continue
        url = pointer_url(repo, file)
        try:
            ptr = fetch(url)
        except Exception as e:  # network, proxy, fixture
            problems.append("%s: could not read %s: %s" % (name, url, e))
            continue
        if ptr is None:
            problems.append("%s: %s answered 404 -- the repo or the file name is wrong" % (name, url))
            continue
        sha, size = read_pointer(ptr)
        if not sha:
            problems.append("%s: %s is not an LFS pointer (no 'oid sha256:' line)" % (name, url))
            continue
        if size and idx in sizes:
            gb = size / 1e9
            if abs(gb - sizes[idx]) > max(0.5, 0.1 * sizes[idx]):
                problems.append("%s: the file is %.2f GB but the menu says ~%s GB -- right quant?"
                                % (name, gb, sizes[idx]))
        have = (fields.get("DL_SHA256") or "").lower()
        if have:
            if have != sha:
                problems.append("%s: the pinned hash %s does not match HuggingFace's %s" % (name, have, sha))
            else:
                print("  ok      %s  %s" % (sha[:12], name))
            continue
        if check:
            print("  unpinned            %s" % name)
            continue
        # Add the pin on the line after DL_FILE, indented to match.
        fm = re.search(r'^([ \t]*)set "DL_FILE=[^"]*"\n', body, re.MULTILINE)
        if not fm:
            problems.append("%s: no DL_FILE line to put the pin under" % name)
            continue
        new_body = body[:fm.end()] + '%sset "DL_SHA256=%s"\n' % (fm.group(1), sha) + body[fm.end():]
        out.append(text[last:m.start(3)])
        out.append(new_body)
        last = m.end(3)
        changes += 1
        print("  %s %s  %s" % ("would pin" if dry else "pinned ", sha[:12], name))
    out.append(text[last:])

    if problems:
        print("\nProblems:")
        for p in problems:
            print("  - " + p)
    if check or dry:
        return 1 if problems else 0
    if changes:
        new = "".join(out)
        if crlf:
            new = new.replace("\n", "\r\n")
        open(bat_path, "wb").write(new.encode("ascii"))
        print("\nwrote %d pin(s) into launch.bat" % changes)
        if regen:
            ini = os.path.join(HERE, "models.ini")
            subprocess.run([sys.executable, os.path.join(HERE, "gen-catalog.py"), bat_path, ini], check=True)
            copy = os.path.join(ROOT, "linux-amd64", "models.ini")
            if os.path.isdir(os.path.dirname(copy)):
                shutil.copyfile(ini, copy)
            print("regenerated catalog/models.ini and linux-amd64/models.ini")
    else:
        print("\nnothing to pin")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
