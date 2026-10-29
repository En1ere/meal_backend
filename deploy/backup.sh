#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

load_deploy_environment
take_lock
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

if ! compose ps --status running --services | grep -qx postgres; then
    echo "PostgreSQL is not running; backup was not created" >&2
    exit 69
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_ROOT/predeploy-$timestamp.dump"
temporary="$target.partial"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

umask 077
actual_user=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres --no-password --tuples-only --no-align \
    --command 'select current_user')
if [ "$actual_user" != "${POSTGRES_USER:-meal_owner}" ]; then
    echo "PostgreSQL backup authentication did not use the expected owner role" >&2
    exit 77
fi
compose exec -T postgres pg_dump \
    --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres \
    --format custom \
    --no-password >"$temporary"

test -s "$temporary"
# Validate with the exact PostgreSQL client shipped in the pinned database image.
compose exec -T postgres sh -ec 'target=$(mktemp); trap '\''rm -f "$target"'\'' EXIT; cat >"$target"; test -s "$target"; pg_restore --list "$target" >/dev/null' <"$temporary"
mv "$temporary" "$target"
sha256sum "$target" >"$target.sha256"
chmod 600 "$target" "$target.sha256"
trap - EXIT HUP INT TERM
printf '%s\n' "$target"
