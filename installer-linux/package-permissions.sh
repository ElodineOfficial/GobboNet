#!/usr/bin/env bash
# Normalize only package staging files; never run against an installed system.
set -euo pipefail
STAGE="${1:?usage: package-permissions.sh STAGING_DIRECTORY}"
[ -d "$STAGE/DEBIAN" ] && [ -f "$STAGE/DEBIAN/control" ] &&
    [ -f "$STAGE/usr/lib/gobbonet/web/chat.html" ] || {
    echo "ERROR: incomplete GobboNet staging tree: $STAGE" >&2
    exit 1
}

chmod 0755 "$STAGE" "$STAGE/DEBIAN"
chmod 0644 "$STAGE/DEBIAN/control"
find "$STAGE/usr" -type d -exec chmod 0755 {} +
# Retain executable bits on engines and launchers; all program files are public.
find "$STAGE/usr" -type f -exec chmod a+r,go-w {} +
find "$STAGE/usr/lib/gobbonet/web" -type f -exec chmod 0644 {} +

bad="$(find "$STAGE/usr" -type d ! -perm 0755 -print -quit)"
[ -z "$bad" ] || { echo "ERROR: inaccessible package directory: $bad" >&2; exit 1; }
bad="$(find "$STAGE/usr" -type f ! -perm -0444 -print -quit)"
[ -z "$bad" ] || { echo "ERROR: unreadable package file: $bad" >&2; exit 1; }
for executable in gobbonet gobbonet-launch llama-cpp/llama-server; do
    path="$STAGE/usr/lib/gobbonet/$executable"
    [ -f "$path" ] && [ "$(stat -c %a "$path")" = 755 ] || {
        echo "ERROR: missing or incorrectly permissioned executable: $path" >&2
        exit 1
    }
done
