#!/usr/bin/env sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 77; }
SECRETS_ROOT=${MEAL_SECRETS_ROOT:-/etc/meal-planner/secrets}
TARGET=${OCR_PREVIEW_TOKEN_FILE:-$SECRETS_ROOT/ocr-preview-token}
case "$SECRETS_ROOT:$TARGET" in
    /etc/meal-planner/secrets:/etc/meal-planner/secrets/ocr-preview-token) ;;
    *) echo "Unsafe OCR preview secret path" >&2; exit 64 ;;
esac
getent group meal-secrets >/dev/null 2>&1 || { echo "meal-secrets group is required" >&2; exit 77; }
[ ! -L "$SECRETS_ROOT" ] && { [ ! -e "$TARGET" ] || [ ! -L "$TARGET" ]; } || {
    echo "Refusing symlinked OCR preview secret path" >&2; exit 77;
}
install -d -o root -g root -m 0750 "$SECRETS_ROOT"
if [ ! -e "$TARGET" ]; then
    temporary="$TARGET.tmp.$$"
    trap 'rm -f "$temporary"' EXIT HUP INT TERM
    umask 077
    (set -C; openssl rand -hex 32 >"$temporary") 2>/dev/null || { echo "Unable to create OCR preview token" >&2; exit 77; }
    chown root:meal-secrets "$temporary"
    chmod 640 "$temporary"
    mv "$temporary" "$TARGET"
    trap - EXIT HUP INT TERM
fi
[ -f "$TARGET" ] && [ ! -L "$TARGET" ] && [ "$(stat -c '%u %G %a' "$TARGET")" = '0 meal-secrets 640' ] || {
    echo "Unsafe OCR preview token metadata" >&2; exit 77;
}
grep -Eq '^[a-f0-9]{64}$' "$TARGET" || { echo "Invalid OCR preview token" >&2; exit 77; }
echo "OCR preview token is ready"
