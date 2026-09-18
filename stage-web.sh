#!/usr/bin/env bash
#
# Assemble internal/webui/assets -- the frontend that gets COMPILED INTO the
# gobbonet binary by internal/webui's go:embed directive.
#
# WHY THIS EXISTS: upstream ships the frontend at the repo root (chat.html plus
# js/ and css/, split out of the old monolith in v1.5). The server wants a web
# root that contains ONLY servable assets -- not launch.bat, not the .ps1
# helpers, not the design docs. Those two requirements used to be reconciled by
# committing a second copy of the frontend under web/, which worked exactly
# until upstream changed a file: the copy went stale silently, the server kept
# serving it, and nothing anywhere reported a problem. With the frontend now
# spread across 40 files instead of one, that failure was a matter of time.
#
# So the staged tree is generated, never committed. The repo root stays the
# single source of truth and merges from upstream land in one place.
#
# WHY IT MOVED (1.7.5): it used to stage ./web, a directory shipped BESIDE the
# binary and found at runtime. That put the same silent-staleness failure inside
# the USER'S install instead of the repo -- they replaced chat.html, js/ and css/
# from a new zip, the old web/ next to the binary kept being served, and every
# server-side feature of the release looked missing. The frontend is now built
# into the executable, so the page and the server are one file and cannot
# disagree. Packagers that still want a copy on disk take it from here.
#
# Run this after pulling upstream changes, or just let the build scripts call
# it. A checkout that has never run it still builds and runs: the embed is empty,
# webui.Staged() reports false, and the server falls back to serving the repo
# root from disk (see internal/server/webroot.go). The only thing missing there
# is /favicon.ico, which is cosmetic and visibly absent rather than silently
# wrong.
set -euo pipefail

cd "$(dirname "$0")"

OUT="internal/webui/assets"

# Files that must exist at the root for the frontend to be complete. A missing
# one means an upstream merge went wrong; say so rather than shipping a web
# root with a hole in it.
REQUIRED_FILES="chat.html default-characters.json gobbonet.ico"
REQUIRED_DIRS="js css"

for f in $REQUIRED_FILES; do
    [ -f "$f" ] || { echo "ERROR: $f missing from the repo root" >&2; exit 1; }
done
for d in $REQUIRED_DIRS; do
    [ -d "$d" ] || { echo "ERROR: $d/ missing from the repo root" >&2; exit 1; }
done

# chat.html loads every module by name, so a partial js/ or css/ is a blank
# page with console errors rather than a build failure. Check the counts match
# what chat.html actually asks for.
want_js=$(grep -c 'src="js/' chat.html)
want_css=$(grep -c 'href="css/' chat.html)
have_js=$(find js -maxdepth 1 -name '*.js' | wc -l)
have_css=$(find css -maxdepth 1 -name '*.css' | wc -l)
if [ "$want_js" -ne "$have_js" ] || [ "$want_css" -ne "$have_css" ]; then
    echo "ERROR: chat.html references $want_js js and $want_css css files;" >&2
    echo "       the tree has $have_js and $have_css. Refusing to stage a" >&2
    echo "       web root that would load a partial frontend." >&2
    exit 1
fi

# Build beside the target and swap, so an interrupted run cannot leave a
# half-populated web/ that looks complete enough to serve.
# The staging directory is created beside the target, so the target's PARENT has
# to exist first. internal/webui/ is committed, but a tree assembled by
# something other than a checkout (the permissions test builds one from a
# handful of copied files) may not have it.
mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d "${OUT}.staging.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

for f in $REQUIRED_FILES; do cp "$f" "$TMP/$f"; done
for d in $REQUIRED_DIRS; do cp -r "$d" "$TMP/$d"; done

# The Go server serves /favicon.ico unauthenticated so the login tab is not
# ugly. Upstream has no favicon.ico -- only gobbonet.ico -- and the two were
# byte-identical when web/ was still committed, so derive it rather than carry
# a third copy of the same image.
cp gobbonet.ico "$TMP/favicon.ico"

# fonts/ is optional and deliberately not in the repo: css/01-tokens.css tells
# the user to drop atkinson-hyperlegible.woff2 there themselves, and sets
# font-display: swap so the fallback stack renders when it is absent. Absent is
# a supported state, so this is not a REQUIRED_DIR -- but if the user did drop
# the file in, it has to reach the web root, or it 404s forever and the only
# symptom is a font that never applies.
fonts=""
if [ -d fonts ]; then
    cp -r fonts "$TMP/fonts"
    fonts=" + $(find fonts -maxdepth 1 -type f | wc -l) font(s)"
fi

# mktemp creates its directory as 0700 even with umask 0022. Once it becomes
# the public web root, every user must be able to traverse it and read assets.
# Normalize copied assets too: source permissions and umask are not a release
# contract. Only this generated public tree is changed, never user data.
find "$TMP" -type d -exec chmod 0755 {} +
find "$TMP" -type f -exec chmod 0644 {} +

# The keep-file is what lets `go:embed all:assets` compile in a fresh clone,
# where nothing has been staged yet. Staging must not remove it, or a build from
# a cleaned tree stops working for a reason that points nowhere near here.
cat > "$TMP/.gitkeep" <<'KEEP'
# stage-web.sh fills this directory; it is gitignored.
# Committed so `go:embed all:assets` has a directory to embed in a fresh clone.
KEEP
chmod 0644 "$TMP/.gitkeep"

rm -rf "$OUT"
mv "$TMP" "$OUT"
trap - EXIT

echo "staged $OUT: chat.html + $have_js js + $have_css css + assets$fonts"
echo "  (compiled into the binary by internal/webui -- rebuild to pick this up)"
