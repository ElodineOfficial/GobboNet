#!/usr/bin/env bash
# Check a staged package payload against payload.manifest.
#
#   ./verify-payload.sh <libdir> <label>
#
# <libdir> is the directory that becomes /usr/lib/gobbonet on Debian or
# /usr/lib64/gobbonet on Fedora. <label> is what to call it in messages.
#
# Lives at the repo root beside stage-web.sh for the same reason that does:
# it is shared build machinery, and both installer directories need it. Kept
# as one script rather than a function copied into each builder, because a
# copied consistency check is the thing it exists to prevent.
#
# Exits non-zero, loudly, on any difference. See payload.manifest for why.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$ROOT/payload.manifest"

LIBDIR="${1:-}"
LABEL="${2:-payload}"

[ -n "$LIBDIR" ] || { echo "usage: $0 <libdir> [label]" >&2; exit 2; }
[ -d "$LIBDIR" ] || { echo "ERROR: $LABEL: no such directory: $LIBDIR" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "ERROR: payload.manifest is missing from $ROOT" >&2; exit 2; }

required=()
optional=()

while IFS= read -r line; do
    line="${line%%#*}"                       # strip comments
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    if [ "${line#\?}" != "$line" ]; then
        optional+=("${line#\?}")
    else
        required+=("$line")
    fi
done < "$MANIFEST"

[ ${#required[@]} -gt 0 ] || { echo "ERROR: payload.manifest lists nothing" >&2; exit 2; }

# What is actually there, one entry per top-level name, directories with a
# trailing slash so "web" and "web/" cannot be confused for one another.
staged=()
while IFS= read -r entry; do
    name="$(basename "$entry")"
    if [ -d "$LIBDIR/$name" ]; then
        staged+=("$name/")
    else
        staged+=("$name")
    fi
done < <(find "$LIBDIR" -mindepth 1 -maxdepth 1 | sort)

contains() {
    local needle="$1"; shift
    local item
    for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
    return 1
}

missing=()
for want in "${required[@]}"; do
    contains "$want" "${staged[@]:-}" || missing+=("$want")
done

unexpected=()
for got in "${staged[@]:-}"; do
    contains "$got" "${required[@]}" && continue
    contains "$got" "${optional[@]:-}" && continue
    unexpected+=("$got")
done

if [ ${#missing[@]} -eq 0 ] && [ ${#unexpected[@]} -eq 0 ]; then
    echo "  payload: ${#staged[@]} entries, matches payload.manifest"
    exit 0
fi

echo "ERROR: $LABEL does not match payload.manifest" >&2
if [ ${#missing[@]} -gt 0 ]; then
    echo "       MISSING (the manifest requires these, staging did not produce them):" >&2
    for m in "${missing[@]}"; do echo "         $m" >&2; done
    echo "       This is the shape of the 1.7.4 Fedora fault: a package that" >&2
    echo "       installs cleanly and then does nothing, because the launcher" >&2
    echo "       reaches for a file that was never staged." >&2
fi
if [ ${#unexpected[@]} -gt 0 ]; then
    echo "       UNEXPECTED (staged but not in the manifest):" >&2
    for u in "${unexpected[@]}"; do echo "         $u" >&2; done
    echo "       If this is deliberate, add it to payload.manifest — which will" >&2
    echo "       then fail the OTHER package until it stages it too. That is the" >&2
    echo "       point of the file." >&2
fi
exit 1
