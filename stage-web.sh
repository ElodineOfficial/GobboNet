#!/usr/bin/env bash
#
# Assemble ./web -- the directory the Go server serves and the one both
# build-release.sh and installer/build-installer.sh bundle.
#
# WHY THIS EXISTS: upstream ships the frontend at the repo root (chat.html plus
# js/ and css/, split out of the old monolith in v1.5). The Go server wants a
# web root that contains ONLY servable assets -- not launch.bat, not the .ps1
# helpers, not the design docs. Those two requirements used to be reconciled by
# committing a second copy of the frontend under web/, which worked exactly
# until upstream changed a file: the copy went stale silently, the server kept
# serving it, and nothing anywhere reported a problem. With the frontend now
# spread across 40 files instead of one, that failure was a matter of time.
#
# So web/ is generated, never committed. The repo root stays the single source
# of truth and merges from upstream land in one place.
#
# Run this after pulling upstream changes, or just let the build scripts call
# it. A dev checkout that has never run it still works: detectWebRoot() falls
# through to the working directory and serves the repo root directly (see
# internal/config/config.go). The only thing missing there is /favicon.ico,
# which is cosmetic and visibly absent rather than silently wrong.
set -euo pipefail

cd "$(dirname "$0")"

OUT="web"

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
want_js=$( (grep -o 'src="js/' chat.html || true) | wc -l)
want_css=$( (grep -o 'href="css/' chat.html || true) | wc -l)
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

rm -rf "$OUT"
mv "$TMP" "$OUT"
trap - EXIT

echo "staged $OUT: chat.html + $have_js js + $have_css css + assets$fonts"
