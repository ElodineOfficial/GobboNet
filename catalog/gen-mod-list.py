#!/usr/bin/env python3
"""
Build gobbonet_mod_list.json, the endorsed-mods list (1.7.9, F6), from a
folder of mod folders. Every file is hashed here, so the list pins exactly the
bytes you are about to upload.

    catalog/gen-mod-list.py MODS_FOLDER --base-url https://goblincorps.com/gobbonet_mods \\
        [--js-as-txt] [--out gobbonet_mod_list.json] [--check]

MODS_FOLDER holds one folder per mod, named by its id, each with a mod.json:

    neon-theme/mod.json   {"name": "Neon theme", "version": "1.2.0",
                           "author": "Elodine", "description": "Pinker everything.",
                           "homepage": "https://goblincorps.com/gobbonet_extras",
                           "adult": false, "min_client": "1.7.9",
                           "files": ["neon.css", "js/neon.js"]}
    neon-theme/neon.css
    neon-theme/js/neon.js

Upload each mod folder to <base-url>/<id>/ as it is. A file's url is
<base-url>/<id>/<path>; with --js-as-txt a script's url gets ".txt" on the end
(neon.js -> neon.js.txt), for a host that will not serve .js files. GobboNet
saves it under its path, as a .js, either way.

--check fetches nothing: it re-hashes the folder and fails if the list at
--out no longer matches it (a file changed after the list was made).
Exit status: 0 done, 1 a mod is not valid or the list is stale, 2 usage.
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
LIST_MIN_CLIENT = "1.7.0"
ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
EXT = {".css", ".js", ".mjs", ".json", ".txt", ".md", ".png", ".jpg", ".jpeg",
       ".gif", ".webp", ".svg", ".woff", ".woff2", ".ttf"}
MAX_FILE = 5 << 20
MAX_FILES = 20


def fail(msg):
    print("gen-mod-list: " + msg, file=sys.stderr)
    sys.exit(1)


def clean_path(p):
    if not isinstance(p, str) or not p or "\\" in p or p.startswith("/"):
        return None
    parts = p.split("/")
    if any(s in ("", ".", "..") or s.startswith(".") for s in parts):
        return None
    return "/".join(parts)


def build_entry(folder, base, js_as_txt):
    mid = folder.name
    if not ID.match(mid):
        fail(f"{mid}: a mod's folder name is its id: lower-case letters, digits, '.', '-' or '_'")
    try:
        man = json.loads((folder / "mod.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{mid}: no mod.json")
    except json.JSONDecodeError as e:
        fail(f"{mid}: mod.json is not valid JSON: {e}")
    if man.get("id") not in (None, mid):
        fail(f"{mid}: mod.json says its id is {man.get('id')!r}; rename the folder or the id")
    for k in ("name", "version"):
        if not str(man.get(k, "")).strip():
            fail(f"{mid}: mod.json needs a {k}")
    files = man.get("files") or []
    if not 1 <= len(files) <= MAX_FILES:
        fail(f"{mid}: list between 1 and {MAX_FILES} files")
    out_files, seen = [], set()
    for f in files:
        p = f if isinstance(f, str) else (f or {}).get("path")
        cp = clean_path(p)
        if not cp:
            fail(f"{mid}: {p!r} is not a plain path inside the mod's folder (URL entries are not endorsed)")
        if Path(cp).suffix.lower() not in EXT:
            fail(f"{mid}: {cp}: GobboNet does not install that kind of file")
        if cp in seen or cp == "mod.json":
            fail(f"{mid}: {cp} is listed twice, or is mod.json")
        seen.add(cp)
        src = folder / cp
        if src.is_symlink() or not src.is_file():
            fail(f"{mid}: {cp} is missing, or is a link")
        body = src.read_bytes()
        if len(body) > MAX_FILE:
            fail(f"{mid}: {cp} is larger than {MAX_FILE >> 20} MB")
        url = f"{base}/{mid}/{cp}"
        if js_as_txt and cp.endswith((".js", ".mjs")):
            url += ".txt"
        out_files.append({"path": cp, "url": url,
                          "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)})
    e = {"id": mid, "type": "mod", "name": str(man["name"]).strip(), "version": str(man["version"]).strip()}
    for k in ("author", "description", "homepage", "min_client"):
        if man.get(k):
            e[k] = str(man[k]).strip()
    if e.get("homepage") and not e["homepage"].startswith("https://"):
        fail(f"{mid}: homepage must be https")
    e["adult"] = bool(man.get("adult", False))
    e["files"] = out_files
    return e


def build(mods_dir, base, js_as_txt):
    base = base.rstrip("/")
    if not base.startswith("https://"):
        fail("--base-url must be https")
    folders = sorted(p for p in Path(mods_dir).iterdir() if p.is_dir() and not p.name.startswith("."))
    if not folders:
        fail(f"no mod folders in {mods_dir}")
    mods = [build_entry(f, base, js_as_txt) for f in folders]
    mods.sort(key=lambda m: m["name"].lower())
    return {"schema_version": SCHEMA, "min_client": LIST_MIN_CLIENT,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "mods": mods}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("mods_dir")
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--js-as-txt", action="store_true")
    ap.add_argument("--out", default="gobbonet_mod_list.json")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if not Path(a.mods_dir).is_dir():
        print(f"gen-mod-list: {a.mods_dir} is not a folder", file=sys.stderr)
        sys.exit(2)
    lst = build(a.mods_dir, a.base_url, a.js_as_txt)
    if a.check:
        try:
            have = json.loads(Path(a.out).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            fail(f"cannot read {a.out}: {e}")
        strip = lambda l: [dict(m) for m in l.get("mods", [])]
        if strip(have) != strip(lst):
            fail(f"{a.out} does not match the folder any more; run without --check to rebuild it")
        print(f"{a.out} matches {len(lst['mods'])} mod(s).")
        return
    Path(a.out).write_text(json.dumps(lst, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    n = sum(len(m["files"]) for m in lst["mods"])
    print(f"wrote {a.out}: {len(lst['mods'])} mod(s), {n} file(s), every one pinned by SHA-256.")


if __name__ == "__main__":
    main()
