#!/usr/bin/env sh
set -eu

DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/meal/deployment}
COMPOSE_FILE=${COMPOSE_FILE:-$DEPLOY_ROOT/compose.production.yml}
ACCOUNT_MAIL_COMPOSE_FILE=${ACCOUNT_MAIL_COMPOSE_FILE:-$DEPLOY_ROOT/compose.account-mail.yml}
DEPLOY_ENV_FILE=${DEPLOY_ENV_FILE:-/etc/meal-planner/deploy.env}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/run/lock/meal-planner-deploy.lock}
STATE_ROOT=${STATE_ROOT:-/var/lib/meal-planner/deployments}
IMAGE_STATE_FILE=${IMAGE_STATE_FILE:-$STATE_ROOT/images.env}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/meal-planner}
MEAL_NETWORK_SUBNET=${MEAL_NETWORK_SUBNET:-172.30.0.0/24}
MEAL_EGRESS_SUBNET=${MEAL_EGRESS_SUBNET:-172.31.0.0/24}
export MEAL_NETWORK_SUBNET MEAL_EGRESS_SUBNET

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
    if [ "${ACCOUNT_MAIL_ENABLED:-false}" = true ]; then
        require_file "$ACCOUNT_MAIL_COMPOSE_FILE"
        docker compose -f "$COMPOSE_FILE" -f "$ACCOUNT_MAIL_COMPOSE_FILE" --profile mail "$@"
    else
        docker compose -f "$COMPOSE_FILE" "$@"
    fi
}

account_mail_enabled() {
    [ "${ACCOUNT_MAIL_ENABLED:-false}" = true ]
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
    mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
    exec 9>"$DEPLOY_LOCK_FILE"
    if ! flock -n 9; then
        echo "Another Meal Planner deployment is running" >&2
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
