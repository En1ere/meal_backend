#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

REPOSITORY=/var/backups/meal-planner/local-restic
PASSWORD_FILE=${LOCAL_BACKUP_PASSWORD_FILE:-/etc/meal-planner/secrets/local-backup-password}
STAGING_ROOT=/var/lib/meal-planner/local-backup-staging
STAGING=$STAGING_ROOT/current
STATUS_FILE=/var/lib/meal-planner/observability/local-backup.json
BACKUP_LOCK=/run/lock/meal-planner-local-backup.lock
MIN_FREE_BYTES=5368709120
MIN_FREE_PERCENT=20
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
failure_code=runtime_failed
seaweed_stopped=false
snapshot_id=
media_included=false
artifact_count=0
backup_json=

safe_remove_staging() {
    resolved=$(realpath -e "$STAGING" 2>/dev/null || true)
    [ "$resolved" != "$STAGING" ] || rm -rf -- "$resolved"
}

previous_json() {
    expression=$1 fallback=$2
    if [ -f "$STATUS_FILE" ]; then
        jq -cer "$expression" "$STATUS_FILE" 2>/dev/null || printf '%s\n' "$fallback"
    else
        printf '%s\n' "$fallback"
    fi
}

publish_status() {
    state=$1 observed_at=$2 current_snapshot=$3 current_failure=$4
    last_success=$(previous_json '.lastSuccessAt // null' null)
    previous_snapshot=$(previous_json '.snapshotId // null' null)
    previous_snapshot_at=$(previous_json '.snapshotAt // null' null)
    restore_drill=$(previous_json '.restoreDrill // {outcome:"not_run",observedAt:null,measuredRestoreSeconds:null}' '{"outcome":"not_run","observedAt":null,"measuredRestoreSeconds":null}')
    previous_repository_bytes=$(previous_json '.repositoryBytes // 0' 0)
    previous_artifact_count=$(previous_json '.artifactCount // 0' 0)
    recovery_key_configured=false
    if [ -f "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] && [ "$(stat -c %u "$PASSWORD_FILE" 2>/dev/null || printf 1)" = 0 ]; then
        case "$(stat -c %a "$PASSWORD_FILE" 2>/dev/null || true)" in 600|640) recovery_key_configured=true ;; esac
    fi
    if [ "$state" = ok ]; then
        last_success=$(printf '%s' "$observed_at" | jq -R .)
        previous_snapshot=$(printf '%s' "$current_snapshot" | jq -R .)
        previous_snapshot_at=$(printf '%s' "$observed_at" | jq -R .)
        previous_repository_bytes=$(du -sb "$REPOSITORY" | awk '{print $1}')
        previous_artifact_count=$artifact_count
    fi
    temporary="$STATUS_FILE.tmp.$$"
    jq -n \
        --arg state "$state" --arg observedAt "$observed_at" --arg lastAttemptAt "$started_at" \
        --arg failureCode "$current_failure" --argjson lastSuccessAt "$last_success" \
        --argjson snapshotId "$previous_snapshot" --argjson snapshotAt "$previous_snapshot_at" \
        --argjson repositoryBytes "$previous_repository_bytes" --argjson artifactCount "$previous_artifact_count" \
        --argjson recoveryKeyConfigured "$recovery_key_configured" \
        --argjson restoreDrill "$restore_drill" \
        '{schemaVersion:1,state:$state,observedAt:$observedAt,lastAttemptAt:$lastAttemptAt,
          lastSuccessAt:$lastSuccessAt,snapshotId:$snapshotId,snapshotAt:$snapshotAt,
          repositoryBytes:$repositoryBytes,artifactCount:$artifactCount,recoveryKeyConfigured:$recoveryKeyConfigured,
          schedule:{timezone:"Asia/Yekaterinburg",localTime:"01:00"},retention:{daily:7,weekly:4},
          policy:{rpoSeconds:86400,rtoSeconds:14400,offsite:false},restoreDrill:$restoreDrill,
          failureCode:(if $failureCode=="" then null else $failureCode end)}' >"$temporary"
    chown root:meal-observability "$temporary"
    chmod 0640 "$temporary"
    mv -f "$temporary" "$STATUS_FILE"
}

restart_seaweed() {
    if [ "$seaweed_stopped" = true ]; then
        compose up -d --wait seaweedfs
        seaweed_stopped=false
    fi
}

on_exit() {
    code=$?
    trap - EXIT HUP INT TERM
    restart_seaweed || { code=$?; failure_code=runtime_failed; }
    safe_remove_staging
    case "$backup_json" in "$STAGING_ROOT"/restic-backup.*.json) rm -f -- "$backup_json" ;; esac
    if [ "$code" -ne 0 ]; then
        publish_status failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "" "$failure_code" || true
    fi
    exit "$code"
}
trap on_exit EXIT HUP INT TERM

[ "$(id -u)" = 0 ] || { echo 'Local backup requires root' >&2; exit 77; }
for command in restic jq docker flock realpath sha256sum; do
    command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 69; }
done
load_deploy_environment
validate_images
take_lock
exec 8>"$BACKUP_LOCK"
flock -n 8 || { echo 'Another local backup or restore drill is running' >&2; exit 75; }

require_file "$PASSWORD_FILE"
if [ -L "$PASSWORD_FILE" ] || [ "$(stat -c %u "$PASSWORD_FILE")" != 0 ]; then
    echo 'Local backup password file is unsafe' >&2; exit 77
fi
case "$(stat -c %a "$PASSWORD_FILE")" in 600|640) ;; *) echo 'Local backup password mode must be 0600 or 0640' >&2; exit 77 ;; esac
export RESTIC_REPOSITORY=$REPOSITORY RESTIC_PASSWORD_FILE=$PASSWORD_FILE

install -d -o root -g root -m 0700 "$REPOSITORY" "$STAGING_ROOT"
[ ! -L "$REPOSITORY" ] && [ ! -L "$STAGING_ROOT" ] || { echo 'Local backup path is unsafe' >&2; exit 77; }
if [ ! -f "$REPOSITORY/config" ]; then
    restic init >/dev/null
fi
restic snapshots --json >/dev/null

free_bytes=$(df -PB1 "$REPOSITORY" | awk 'NR==2 {print $4}')
total_bytes=$(df -PB1 "$REPOSITORY" | awk 'NR==2 {print $2}')
free_percent=$((free_bytes * 100 / total_bytes))
database_bytes=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" --dbname meal_planner_postgres --no-password --tuples-only --no-align --command "select pg_database_size('meal_planner_postgres')" 2>/dev/null || true)
case "$database_bytes" in ''|*[!0-9]*) failure_code=postgres_unavailable; echo 'Database size probe failed' >&2; exit 69 ;; esac
media_bytes=0
if [ -d "$MEDIA_STORAGE_HOST_ROOT" ]; then media_bytes=$(du -sb "$MEDIA_STORAGE_HOST_ROOT" | awk '{print $1}'); fi
required_bytes=$((MIN_FREE_BYTES + database_bytes + media_bytes))
if [ "$free_bytes" -lt "$required_bytes" ] || [ "$free_percent" -lt "$MIN_FREE_PERCENT" ]; then
    failure_code=disk_guard
    echo 'Local backup disk guard rejected the run' >&2
    exit 75
fi
staging_free_bytes=$(df -PB1 "$STAGING_ROOT" | awk 'NR==2 {print $4}')
staging_total_bytes=$(df -PB1 "$STAGING_ROOT" | awk 'NR==2 {print $2}')
staging_free_percent=$((staging_free_bytes * 100 / staging_total_bytes))
staging_required_bytes=$((MIN_FREE_BYTES + database_bytes))
if [ "$staging_free_bytes" -lt "$staging_required_bytes" ] || [ "$staging_free_percent" -lt "$MIN_FREE_PERCENT" ]; then
    failure_code=disk_guard
    echo 'Local backup staging disk guard rejected the run' >&2
    exit 75
fi
if ! compose ps --status running --services | grep -qx postgres; then
    failure_code=postgres_unavailable; echo 'PostgreSQL is not running' >&2; exit 69
fi

safe_remove_staging
[ ! -e "$STAGING" ] && [ ! -L "$STAGING" ] || { echo 'Local backup staging path is unsafe' >&2; exit 77; }
install -d -o root -g root -m 0700 "$STAGING"
failure_code=snapshot_failed
compose exec -T postgres pg_dump --username "${POSTGRES_USER:-meal_owner}" --dbname meal_planner_postgres --format custom --no-password >"$STAGING/postgres.dump.partial"
test -s "$STAGING/postgres.dump.partial"
compose exec -T postgres sh -ec 'target=$(mktemp); trap '\''rm -f "$target"'\'' EXIT; cat >"$target"; pg_restore --list "$target" >/dev/null' <"$STAGING/postgres.dump.partial"
mv "$STAGING/postgres.dump.partial" "$STAGING/postgres.dump"

docker run --rm --network none --entrypoint cat "$BACKEND_IMAGE" database/manifest.json >"$STAGING/migration-manifest.json"
docker run --rm --network none --entrypoint cat "$BACKEND_IMAGE" database/application-grants.sql >"$STAGING/application-grants.sql"
{
    printf 'BACKEND_IMAGE=%s\nPOSTGRES_IMAGE=%s\nFRONTEND_IMAGE=%s\nADMIN_IMAGE=%s\nBACKEND_VERSION=%s\n' \
        "$BACKEND_IMAGE" "$POSTGRES_IMAGE" "$FRONTEND_IMAGE" "$ADMIN_IMAGE" "$BACKEND_VERSION"
    printf 'ACCOUNT_MAIL_ENABLED=%s\nMEDIA_STORAGE_INFRA_ENABLED=%s\nMEDIA_STORAGE_ENABLED=%s\n' \
        "${ACCOUNT_MAIL_ENABLED:-false}" "${MEDIA_STORAGE_INFRA_ENABLED:-false}" "${MEDIA_STORAGE_ENABLED:-false}"
    printf 'MEDIA_PROCESSOR_ENABLED=%s\nOCR_PREVIEW_ENABLED=%s\nWEB_PUSH_ENABLED=%s\n' \
        "${MEDIA_PROCESSOR_ENABLED:-false}" "${OCR_PREVIEW_ENABLED:-false}" "${WEB_PUSH_ENABLED:-false}"
    if media_infra_enabled; then printf 'SEAWEEDFS_IMAGE=%s\n' "$SEAWEEDFS_IMAGE"; fi
} >"$STAGING/deployment-inventory.txt"

if media_infra_enabled; then
    if media_storage_enabled; then
        failure_code=media_unsafe
        echo 'Enabled media storage requires a separately approved provider snapshot strategy' >&2
        exit 77
    fi
    compose ps --status running --services | grep -qx seaweedfs || { failure_code=media_unsafe; echo 'SeaweedFS is not running' >&2; exit 69; }
    compose stop -t 120 seaweedfs
    seaweed_stopped=true
    media_included=true
fi
if [ -d "$MEDIA_STORAGE_HOST_ROOT" ]; then
    (cd "$MEDIA_STORAGE_HOST_ROOT" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) >"$STAGING/media.sha256"
else
    : >"$STAGING/media.sha256"
fi
cat >"$STAGING/local-policy.json" <<'JSON'
{"schemaVersion":1,"schedule":{"localTime":"01:00","timezone":"Asia/Yekaterinburg"},"retention":{"daily":7,"weekly":4},"policy":{"rpoSeconds":86400,"rtoSeconds":14400,"offsite":false},"encrypted":true,"secrets":"excluded"}
JSON
(cd "$STAGING" && find . -maxdepth 1 -type f ! -name ARTIFACTS.sha256 -print0 | sort -z | xargs -0 sha256sum) >"$STAGING/ARTIFACTS.sha256"
stage_count=$(find "$STAGING" -maxdepth 1 -type f | wc -l)
artifact_count=$stage_count
# The status field counts bounded logical artifacts, not every file in the media tree.
# Individual media files are covered by media.sha256 and by the restic snapshot.
if [ -d "$MEDIA_STORAGE_HOST_ROOT" ]; then artifact_count=$((artifact_count + 1)); fi

backup_json="$STAGING_ROOT/restic-backup.$$.json"
if [ -d "$MEDIA_STORAGE_HOST_ROOT" ]; then
    restic backup --json --tag meal-local-daily "$STAGING" "$MEDIA_STORAGE_HOST_ROOT" >"$backup_json"
else
    restic backup --json --tag meal-local-daily "$STAGING" >"$backup_json"
fi
snapshot_id=$(jq -rs -er '[.[] | select(.message_type=="summary")][-1].snapshot_id | select(test("^[a-f0-9]{64}$"))' "$backup_json")
rm -f "$backup_json"
restart_seaweed

failure_code=verification_failed
restic check >/dev/null
restic snapshots --json "$snapshot_id" | jq -e --arg id "$snapshot_id" 'length==1 and .[0].id==$id' >/dev/null
restic forget --tag meal-local-daily --group-by host,paths,tags --keep-daily 7 --keep-weekly 4 --prune >/dev/null

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
publish_status ok "$completed_at" "$snapshot_id" ""
safe_remove_staging
trap - EXIT HUP INT TERM
printf 'Local encrypted backup completed: snapshot=%s media=%s offsite=false\n' "$snapshot_id" "$media_included"
