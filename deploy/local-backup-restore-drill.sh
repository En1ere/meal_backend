#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

REPOSITORY=/var/backups/meal-planner/local-restic
PASSWORD_FILE=${LOCAL_BACKUP_PASSWORD_FILE:-/etc/meal-planner/secrets/local-backup-password}
STATUS_FILE=/var/lib/meal-planner/observability/local-backup.json
RESTORE_ROOT=/var/lib/meal-planner/local-backup-restore
BACKUP_LOCK=/run/lock/meal-planner-local-backup.lock
snapshot= change_ticket=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --snapshot) snapshot=${2:-}; shift 2 ;;
        --change-ticket) change_ticket=${2:-}; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 64 ;;
    esac
done
printf '%s\n' "$snapshot" | grep -Eq '^[a-f0-9]{64}$' || { echo '--snapshot must be an exact restic snapshot ID' >&2; exit 64; }
printf '%s\n' "$change_ticket" | grep -Eq '^[A-Z][A-Z0-9-]{2,63}$' || { echo '--change-ticket is invalid' >&2; exit 64; }

started_epoch=$(date +%s)
failure_code=restore_failed
container="meal-local-restore-$(printf '%s' "$snapshot" | cut -c1-12)-$$"
target="$RESTORE_ROOT/$snapshot"

safe_cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    resolved=$(realpath -e "$target" 2>/dev/null || true)
    [ "$resolved" != "$target" ] || rm -rf -- "$resolved"
}

update_status() {
    outcome=$1 observed_at=$2 measured=$3 current_failure=$4
    [ -f "$STATUS_FILE" ] || return 0
    temporary="$STATUS_FILE.tmp.$$"
    jq --arg outcome "$outcome" --arg observedAt "$observed_at" --arg failureCode "$current_failure" \
       --argjson measuredRestoreSeconds "$measured" \
       '.state=(if $outcome=="passed" then .state else "failed" end) |
        .observedAt=$observedAt |
        .failureCode=(if $outcome=="passed" then .failureCode else $failureCode end) |
        .restoreDrill={outcome:$outcome,observedAt:$observedAt,measuredRestoreSeconds:$measuredRestoreSeconds}' \
       "$STATUS_FILE" >"$temporary"
    chown root:meal-observability "$temporary"
    chmod 0640 "$temporary"
    mv -f "$temporary" "$STATUS_FILE"
}

on_exit() {
    code=$?
    trap - EXIT HUP INT TERM
    safe_cleanup
    if [ "$code" -ne 0 ]; then
        elapsed=$(($(date +%s) - started_epoch))
        update_status failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed" "$failure_code" || true
    fi
    exit "$code"
}
trap on_exit EXIT HUP INT TERM

[ "$(id -u)" = 0 ] || { echo 'Restore drill requires root' >&2; exit 77; }
for command in restic jq docker flock realpath sha256sum; do
    command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 69; }
done
load_deploy_environment
validate_images
take_lock
exec 8>"$BACKUP_LOCK"
flock -n 8 || { echo 'Backup or restore drill is already running' >&2; exit 75; }
require_file "$PASSWORD_FILE"
if [ -L "$PASSWORD_FILE" ] || [ "$(stat -c %u "$PASSWORD_FILE")" != 0 ]; then
    echo 'Local backup password file is unsafe' >&2; exit 77
fi
case "$(stat -c %a "$PASSWORD_FILE")" in 600|640) ;; *) echo 'Local backup password mode must be 0600 or 0640' >&2; exit 77 ;; esac
require_file "$STATUS_FILE"
export RESTIC_REPOSITORY=$REPOSITORY RESTIC_PASSWORD_FILE=$PASSWORD_FILE
restic snapshots --json "$snapshot" | jq -e --arg id "$snapshot" 'length==1 and .[0].id==$id' >/dev/null

safe_cleanup
[ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'Restore target path is unsafe' >&2; exit 77; }
install -d -o root -g root -m 0700 "$RESTORE_ROOT" "$target"
restic restore "$snapshot" --target "$target" >/dev/null
stage="$target/var/lib/meal-planner/local-backup-staging/current"
dump="$stage/postgres.dump"
require_file "$dump"
require_file "$stage/migration-manifest.json"
(cd "$stage" && sha256sum -c ARTIFACTS.sha256 >/dev/null)
expected_facts=$(jq -r '[(.migrations|length),.totalTables,.foreignKeys,.postgresMajor]|join("/")' \
    "$stage/migration-manifest.json")
printf '%s\n' "$expected_facts" | grep -Eq '^[0-9]+/[0-9]+/[0-9]+/[0-9]+$' || {
    echo 'Backup database manifest is invalid' >&2; exit 65;
}
expected_migration_count=${expected_facts%%/*}

docker run -d --name "$container" --network none --tmpfs /var/lib/postgresql:rw,nosuid,nodev,noexec,size=2g \
    -e POSTGRES_DB=meal_planner_postgres -e POSTGRES_USER=meal_owner -e POSTGRES_HOST_AUTH_METHOD=trust "$POSTGRES_IMAGE" >/dev/null
attempts=60
until docker exec "$container" pg_isready -U meal_owner -d meal_planner_postgres >/dev/null 2>&1; do
    attempts=$((attempts - 1))
    [ "$attempts" -gt 0 ] || { echo 'Isolated PostgreSQL did not start' >&2; exit 69; }
    sleep 2
done
docker cp "$dump" "$container:/tmp/meal-local-restore.dump"
docker exec --user root "$container" chown postgres:postgres /tmp/meal-local-restore.dump
docker exec --user postgres "$container" pg_restore --exit-on-error --single-transaction --no-owner --no-acl -U meal_owner -d meal_planner_postgres /tmp/meal-local-restore.dump
facts=$(docker exec "$container" psql -U meal_owner -d meal_planner_postgres --tuples-only --no-align --field-separator / --command "select (select count(*) from meal.schema_migrations),(select count(*) from information_schema.tables where table_schema='meal' and table_type='BASE TABLE'),(select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='meal' and c.contype='f'),current_setting('server_version_num')::int/10000,not exists(select 1 from generate_series(1,$expected_migration_count) expected(version) left join meal.schema_migrations actual using(version) where actual.version is null)")
[ "$facts" = "$expected_facts/t" ] || { echo 'Restored database invariant mismatch' >&2; exit 65; }
docker exec "$container" psql -U meal_owner -d meal_planner_postgres -v ON_ERROR_STOP=1 --command 'begin isolation level serializable; select count(*) from meal.users; rollback' >/dev/null

media_root="$target${MEDIA_STORAGE_HOST_ROOT}"
manifest="$stage/media.sha256"
if [ -s "$manifest" ]; then
    [ -d "$media_root" ] || { echo 'Restored media directory is missing' >&2; exit 65; }
    (cd "$media_root" && sha256sum -c "$manifest" >/dev/null)
elif [ -d "$media_root" ] && find "$media_root" -type f -print -quit | grep -q .; then
    echo 'Unexpected media files were restored' >&2
    exit 65
fi

elapsed=$(($(date +%s) - started_epoch))
[ "$elapsed" -le 14400 ] || { echo 'Restore drill exceeded the four-hour RTO' >&2; exit 65; }
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
update_status passed "$completed_at" "$elapsed" ""
safe_cleanup
trap - EXIT HUP INT TERM
printf 'Isolated restore drill passed: snapshot=%s seconds=%s source_unchanged=true\n' "$snapshot" "$elapsed"
