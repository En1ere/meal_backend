#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

component= candidate_image= revision=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --component) component=${2:-}; shift 2 ;;
        --image) candidate_image=${2:-}; shift 2 ;;
        --revision) revision=${2:-}; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 64 ;;
    esac
done
case "$component" in backend|frontend|admin) ;; *) echo "--component must be backend, frontend or admin" >&2; exit 64 ;; esac
require_digest_reference candidate-image "$candidate_image"
load_deploy_environment
validate_images
take_lock

previous_image=$(component_image "$component")
require_digest_reference "previous $component image" "$previous_image"
set_component_image "$component" "$candidate_image"
mkdir -p "$STATE_ROOT"; chmod 700 "$STATE_ROOT"
deployment_id=$(date -u +%Y%m%dT%H%M%SZ)-$component
state_dir="$STATE_ROOT/$deployment_id"
mkdir -m 700 "$state_dir"
printf '%s\n' "$component" >"$state_dir/component"
printf '%s\n' "$previous_image" >"$state_dir/previous.image"
printf '%s\n' "$candidate_image" >"$state_dir/candidate.image"
printf '%s\n' "${revision:-unknown}" >"$state_dir/revision"

compose config --quiet
if [ "$component" = backend ]; then compose pull backend worker; else compose pull "$component"; fi
if [ "$component" = backend ]; then
    # Only backend releases own schema changes. UI-only releases never touch PostgreSQL.
    MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/backup.sh" >"$state_dir/backup.path"
    compose stop backend worker
    compose --profile tools run --rm migrate
    compose --profile tools run --rm --no-deps --entrypoint cat migrate database/application-grants.sql \
        | compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
            --dbname meal_planner_postgres --no-password --set ON_ERROR_STOP=1
    MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/proxy-smoke.sh" >"$state_dir/proxy-smoke.txt"
fi

if [ "$component" = backend ]; then compose up -d --no-deps backend worker; else compose up -d --no-deps "$component"; fi
if ! MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/verify.sh" --component "$component"; then
    printf '%s\n' failed >"$state_dir/status"
    if [ "$component" = backend ] && {
        [ "${ALLOW_BACKEND_AUTO_ROLLBACK:-false}" != true ] ||
        [ ! -r "${BACKEND_ROLLBACK_EVIDENCE_FILE:-}" ] ||
        [ "$(stat -c %u "${BACKEND_ROLLBACK_EVIDENCE_FILE:-/nonexistent}" 2>/dev/null || echo invalid)" != 0 ] ||
        ! grep -Fqx "previous_image=$previous_image" "$BACKEND_ROLLBACK_EVIDENCE_FILE" ||
        ! grep -Fqx "candidate_image=$candidate_image" "$BACKEND_ROLLBACK_EVIDENCE_FILE" ||
        ! grep -Fqx 'schema_version=29' "$BACKEND_ROLLBACK_EVIDENCE_FILE";
    }; then
        echo "Backend verification failed after migration; fail-closed until compatibility evidence authorizes application rollback" >&2
        exit 1
    fi
    set_component_image "$component" "$previous_image"
    if [ "$component" = backend ]; then
        compose pull backend worker
        compose up -d --no-deps backend worker
    else
        compose pull "$component"
        compose up -d --no-deps "$component"
    fi
    if ! MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/verify.sh" --component "$component"; then
        printf '%s\n' rollback-failed >"$state_dir/rollback-status"
        echo "Candidate and previous $component images failed verification; database was not rolled back" >&2
        exit 1
    fi
    printf '%s\n' restored >"$state_dir/rollback-status"
    echo "Candidate failed; previous $component digest was restored. Database was not rolled back." >&2
    exit 1
fi

persist_images
printf '%s\n' passed >"$state_dir/status"
ln -sfn "$state_dir" "$STATE_ROOT/current-$component"
echo "Deployment $deployment_id passed"
