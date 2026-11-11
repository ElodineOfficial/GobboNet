#!/usr/bin/env bash
# Stage the Windows installer's payload into ../staging, ready for
#   makensis gobbonet.nsi
#
# usage: installer-win/stage-payload.sh <source>
#   <source> is an unpacked release ZIP (its GobboNet/ folder) or the repo
#   root after bash ./scripts/make-zip.sh, so gobbonet.exe is there. Staging from the ZIP
#   puts the exact same files in the installer as in the ZIP beside it.
#
# The file list is read from gobbonet.nsi itself (its File "${APPSRC}\..."
# lines), so the script and the payload cannot drift apart. Two files live
# elsewhere in the tree and are installed at the top level, as README.md says:
#   PURGE.md   <- docs/PURGE.md
#   models.ini <- catalog/models.ini
set -euo pipefail

src="${1:?usage: $0 <unpacked ZIP folder or repo root>}"
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../staging"

[ -f "$src/gobbonet.exe" ] || { echo "no gobbonet.exe in $src: run bash ./scripts/make-zip.sh first, or point at the unpacked ZIP" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
n=0
# File "${APPSRC}\name" and File /oname=... "${APPSRC}\name"; wildcards (js\*.js) too.
while IFS= read -r rel; do
  case "$rel" in
    PURGE.md)   from="docs/PURGE.md" ;;
    models.ini) from="catalog/models.ini" ;;
    *)          from="$rel" ;;
  esac
  dir="$(dirname "$rel")"
  mkdir -p "$dest/$dir"
  # shellcheck disable=SC2086 # the glob in $from is meant to expand
  set -- "$src"/$from
  [ -e "$1" ] || { echo "missing from $src: $from" >&2; exit 1; }
  cp -p "$@" "$dest/$dir/"
  n=$((n + $#))
done < <(grep -oE 'File (/oname=[^ ]+ )?"\$\{APPSRC\}\\[^"]+"' "$here/gobbonet.nsi" \
           | sed -E 's/.*\$\{APPSRC\}\\([^"]+)"/\1/; s#\\#/#g' | sort -u)
echo "staged $n files into $(cd "$dest" && pwd)"
