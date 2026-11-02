#!/usr/bin/env sh
set -eu

DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/meal/deployment}
COMPOSE_FILE=${COMPOSE_FILE:-$DEPLOY_ROOT/compose.production.yml}
ACCOUNT_MAIL_COMPOSE_FILE=${ACCOUNT_MAIL_COMPOSE_FILE:-$DEPLOY_ROOT/compose.account-mail.yml}
MEDIA_INFRA_COMPOSE_FILE=${MEDIA_INFRA_COMPOSE_FILE:-$DEPLOY_ROOT/compose.media-local.yml}
MEDIA_BACKEND_COMPOSE_FILE=${MEDIA_BACKEND_COMPOSE_FILE:-$DEPLOY_ROOT/compose.media-backend.yml}
MEDIA_PROCESSOR_COMPOSE_FILE=${MEDIA_PROCESSOR_COMPOSE_FILE:-$DEPLOY_ROOT/compose.media-processor.yml}
OCR_PREVIEW_COMPOSE_FILE=${OCR_PREVIEW_COMPOSE_FILE:-$DEPLOY_ROOT/compose.ocr-preview.yml}
WEB_PUSH_COMPOSE_FILE=${WEB_PUSH_COMPOSE_FILE:-$DEPLOY_ROOT/compose.web-push.yml}
DEPLOY_ENV_FILE=${DEPLOY_ENV_FILE:-/etc/meal-planner/deploy.env}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/run/lock/meal-planner-deploy.lock}
DEPLOY_LOCK_WAIT_SECONDS=${DEPLOY_LOCK_WAIT_SECONDS:-300}
STATE_ROOT=${STATE_ROOT:-/var/lib/meal-planner/deployments}
IMAGE_STATE_FILE=${IMAGE_STATE_FILE:-$STATE_ROOT/images.env}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/meal-planner}
MEAL_NETWORK_SUBNET=${MEAL_NETWORK_SUBNET:-172.30.0.0/24}
MEAL_EGRESS_SUBNET=${MEAL_EGRESS_SUBNET:-172.31.0.0/24}
MEAL_MEDIA_SUBNET=${MEAL_MEDIA_SUBNET:-172.29.0.0/24}
MEAL_OCR_SUBNET=${MEAL_OCR_SUBNET:-172.28.0.0/24}
MEDIA_STORAGE_HOST_ROOT=${MEDIA_STORAGE_HOST_ROOT:-/var/lib/meal-planner/media/provider}
MEDIA_STORAGE_MIN_FREE_BYTES=${MEDIA_STORAGE_MIN_FREE_BYTES:-5368709120}
MEDIA_STORAGE_MIN_FREE_PERCENT=${MEDIA_STORAGE_MIN_FREE_PERCENT:-20}
export MEAL_NETWORK_SUBNET MEAL_EGRESS_SUBNET MEAL_MEDIA_SUBNET MEAL_OCR_SUBNET

require_file() {
    if [ ! -r "$1" ]; then
        echo "Required file is not readable: $1" >&2
        exit 66
    fi
}

load_deploy_environment() {
    require_file "$DEPLOY_ENV_FILE"
    set -a
    # This root-owned file contains image digests and non-secret deployment settings only.
    # shellcheck disable=SC1090
    . "$DEPLOY_ENV_FILE"
    if [ -r "$IMAGE_STATE_FILE" ]; then
        # Generated only by persist_images after digest validation.
        . "$IMAGE_STATE_FILE"
    fi
    set +a
}

require_digest_reference() {
    if ! printf '%s\n' "$2" | grep -Eq '^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$'; then
        echo "$1 must be an immutable sha256 digest reference" >&2
        exit 64
    fi
}

validate_images() {
    require_digest_reference POSTGRES_IMAGE "${POSTGRES_IMAGE:-}"
    require_digest_reference BACKEND_IMAGE "${BACKEND_IMAGE:-}"
    require_digest_reference FRONTEND_IMAGE "${FRONTEND_IMAGE:-}"
    require_digest_reference ADMIN_IMAGE "${ADMIN_IMAGE:-}"
    require_semver BACKEND_VERSION "${BACKEND_VERSION:-}"
    if media_infra_enabled; then
        require_digest_reference SEAWEEDFS_IMAGE "${SEAWEEDFS_IMAGE:-}"
    fi
    validate_media_flags
}

require_semver() {
    if ! printf '%s\n' "$2" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "$1 must be a numeric SemVer release" >&2
        exit 64
    fi
}

image_package_version() {
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
        --entrypoint node "$1" --input-type=module --eval \
        'import fs from "node:fs";const value=JSON.parse(fs.readFileSync("/app/package.json","utf8")).version;process.stdout.write(String(value));'
}

compose() {
    validate_media_flags
    compose_files="-f $COMPOSE_FILE"
    compose_profiles=
    if account_mail_enabled; then
        require_file "$ACCOUNT_MAIL_COMPOSE_FILE"
        compose_files="$compose_files -f $ACCOUNT_MAIL_COMPOSE_FILE"
        compose_profiles='--profile mail'
    fi
    if media_infra_enabled; then
        require_file "$MEDIA_INFRA_COMPOSE_FILE"
        compose_files="$compose_files -f $MEDIA_INFRA_COMPOSE_FILE"
    fi
    if media_storage_enabled; then
        require_file "$MEDIA_BACKEND_COMPOSE_FILE"
        compose_files="$compose_files -f $MEDIA_BACKEND_COMPOSE_FILE"
    fi
    if media_processor_enabled; then
        require_file "$MEDIA_PROCESSOR_COMPOSE_FILE"
        compose_files="$compose_files -f $MEDIA_PROCESSOR_COMPOSE_FILE"
        compose_profiles="$compose_profiles --profile media-processor"
    fi
    if ocr_preview_enabled; then
        require_file "$OCR_PREVIEW_COMPOSE_FILE"
        compose_files="$compose_files -f $OCR_PREVIEW_COMPOSE_FILE"
        compose_profiles="$compose_profiles --profile ocr-preview"
    fi
    if web_push_enabled; then
        require_file "$WEB_PUSH_COMPOSE_FILE"
        compose_files="$compose_files -f $WEB_PUSH_COMPOSE_FILE"
        compose_profiles="$compose_profiles --profile web-push"
    fi
    # Deployment paths are fixed root-owned paths without whitespace.
    # shellcheck disable=SC2086
    docker compose $compose_files $compose_profiles "$@"
}

compose_web_push_overlay() {
    require_file "$WEB_PUSH_COMPOSE_FILE"
    docker compose -f "$COMPOSE_FILE" -f "$WEB_PUSH_COMPOSE_FILE" --profile web-push "$@"
}

remove_disabled_web_push_worker() {
    if ! web_push_enabled && [ -r "$WEB_PUSH_COMPOSE_FILE" ]; then
        compose_web_push_overlay rm --stop --force push-worker >/dev/null
    fi
}

account_mail_enabled() {
    [ "${ACCOUNT_MAIL_ENABLED:-false}" = true ]
}

media_infra_enabled() {
    [ "${MEDIA_STORAGE_INFRA_ENABLED:-false}" = true ]
}

media_storage_enabled() {
    [ "${MEDIA_STORAGE_ENABLED:-false}" = true ]
}

media_processor_enabled() {
    [ "${MEDIA_PROCESSOR_ENABLED:-false}" = true ]
}

ocr_preview_enabled() {
    [ "${OCR_PREVIEW_ENABLED:-false}" = true ]
}

web_push_enabled() { [ "${WEB_PUSH_ENABLED:-false}" = true ]; }

validate_media_flags() {
    case "${MEDIA_STORAGE_INFRA_ENABLED:-false}" in true|false) ;; *) echo "MEDIA_STORAGE_INFRA_ENABLED must be true or false" >&2; exit 64 ;; esac
    case "${MEDIA_STORAGE_ENABLED:-false}" in true|false) ;; *) echo "MEDIA_STORAGE_ENABLED must be true or false" >&2; exit 64 ;; esac
    case "${MEDIA_PROCESSOR_ENABLED:-false}" in true|false) ;; *) echo "MEDIA_PROCESSOR_ENABLED must be true or false" >&2; exit 64 ;; esac
    case "${OCR_PREVIEW_ENABLED:-false}" in true|false) ;; *) echo "OCR_PREVIEW_ENABLED must be true or false" >&2; exit 64 ;; esac
    case "${WEB_PUSH_ENABLED:-false}" in true|false) ;; *) echo "WEB_PUSH_ENABLED must be true or false" >&2; exit 64 ;; esac
    if media_storage_enabled && ! media_infra_enabled; then
        echo "MEDIA_STORAGE_ENABLED requires MEDIA_STORAGE_INFRA_ENABLED=true" >&2
        exit 64
    fi
    if media_processor_enabled && ! media_infra_enabled; then
        echo "MEDIA_PROCESSOR_ENABLED requires MEDIA_STORAGE_INFRA_ENABLED=true" >&2
        exit 64
    fi
}

verify_media_host_storage() {
    [ -d "$MEDIA_STORAGE_HOST_ROOT" ] && [ ! -L "$MEDIA_STORAGE_HOST_ROOT" ] || {
        echo "Media storage host bootstrap is required" >&2
        exit 78
    }
    [ "$(stat -c '%u %g %a' "$MEDIA_STORAGE_HOST_ROOT")" = '0 29003 2770' ] || {
        echo "Media storage host directory metadata is unsafe" >&2
        exit 78
    }
    free_kib=$(df -Pk "$MEDIA_STORAGE_HOST_ROOT" | awk 'NR==2 {print $4}')
    used_percent=$(df -Pk "$MEDIA_STORAGE_HOST_ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
    case "$free_kib:$used_percent:$MEDIA_STORAGE_MIN_FREE_BYTES:$MEDIA_STORAGE_MIN_FREE_PERCENT" in
        *[!0-9:]*|'') echo "Media storage disk guard received invalid capacity data" >&2; exit 78 ;;
    esac
    free_bytes=$((free_kib * 1024))
    free_percent=$((100 - used_percent))
    [ "$free_bytes" -ge "$MEDIA_STORAGE_MIN_FREE_BYTES" ] && \
        [ "$free_percent" -ge "$MEDIA_STORAGE_MIN_FREE_PERCENT" ] || {
        echo "Media storage disk guard refused operation" >&2
        exit 78
    }
}

persist_images() {
    validate_images
    mkdir -p "$STATE_ROOT"
    chmod 700 "$STATE_ROOT"
    temporary="$IMAGE_STATE_FILE.tmp.$$"
    umask 077
    {
        printf 'POSTGRES_IMAGE=%s\n' "$POSTGRES_IMAGE"
        printf 'BACKEND_IMAGE=%s\n' "$BACKEND_IMAGE"
        printf 'BACKEND_VERSION=%s\n' "$BACKEND_VERSION"
        printf 'FRONTEND_IMAGE=%s\n' "$FRONTEND_IMAGE"
        printf 'ADMIN_IMAGE=%s\n' "$ADMIN_IMAGE"
    } >"$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$IMAGE_STATE_FILE"
}

set_component_image() {
    case "$1" in
        backend) BACKEND_IMAGE=$2; export BACKEND_IMAGE ;;
        frontend) FRONTEND_IMAGE=$2; export FRONTEND_IMAGE ;;
        admin) ADMIN_IMAGE=$2; export ADMIN_IMAGE ;;
        *) echo "Unsupported component: $1" >&2; exit 64 ;;
    esac
}

component_image() {
    case "$1" in
        backend) printf '%s\n' "$BACKEND_IMAGE" ;;
        frontend) printf '%s\n' "$FRONTEND_IMAGE" ;;
        admin) printf '%s\n' "$ADMIN_IMAGE" ;;
        *) echo "Unsupported component: $1" >&2; exit 64 ;;
    esac
}

take_lock() {
    if [ "${MEAL_LOCK_HELD:-0}" = 1 ]; then
        return
    fi
    case "$DEPLOY_LOCK_WAIT_SECONDS" in
        ''|*[!0-9]*) echo "DEPLOY_LOCK_WAIT_SECONDS must be an integer from 1 to 900" >&2; exit 64 ;;
    esac
    if [ "$DEPLOY_LOCK_WAIT_SECONDS" -lt 1 ] || [ "$DEPLOY_LOCK_WAIT_SECONDS" -gt 900 ]; then
        echo "DEPLOY_LOCK_WAIT_SECONDS must be an integer from 1 to 900" >&2
        exit 64
    fi
    mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
    exec 9>"$DEPLOY_LOCK_FILE"
    if ! flock -w "$DEPLOY_LOCK_WAIT_SECONDS" 9; then
        echo "Another Meal Planner deployment did not finish within ${DEPLOY_LOCK_WAIT_SECONDS}s" >&2
        exit 75
    fi
}

current_image() {
    container_id=$(compose ps -q "$1")
    if [ -z "$container_id" ]; then
        return 0
    fi
    docker inspect --format '{{.Config.Image}}' "$container_id"
}

validate_network_route() {
    network=$1 subnet=$2
    if docker network inspect "$network" >/dev/null 2>&1; then
        actual=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$network")
        [ "$actual" = "$subnet" ] || { echo "$network has unexpected subnet" >&2; exit 77; }
    elif ip route show | grep -Fq "$subnet"; then
        echo "$subnet already exists in the host routing table; choose a non-conflicting explicit subnet" >&2
        exit 77
    fi
}
