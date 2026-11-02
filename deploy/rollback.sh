#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

component= state_dir=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --component) component=${2:-}; shift 2 ;;
        --state) state_dir=${2:-}; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 64 ;;
    esac
done
case "$component" in backend|frontend|admin) ;; *) echo "--component is required" >&2; exit 64 ;; esac
[ "${ALLOW_APPLICATION_ROLLBACK:-false}" = true ] || {
    echo "Set ALLOW_APPLICATION_ROLLBACK=true only after confirming schema compatibility" >&2; exit 77;
}
load_deploy_environment
if [ "$component" = backend ] && ocr_preview_enabled; then
    echo "Disable OCR preview before backend image rollback" >&2
    exit 77
fi
take_lock
if media_infra_enabled; then
    verify_media_host_storage
    validate_network_route meal-media "$MEAL_MEDIA_SUBNET"
    compose up -d --no-deps seaweedfs
fi
state_dir=${state_dir:-$STATE_ROOT/current-$component}
state_dir=$(readlink -f "$state_dir")
case "$state_dir" in "$STATE_ROOT"/*) ;; *) echo "Rollback state must be under $STATE_ROOT" >&2; exit 64 ;; esac
require_file "$state_dir/previous.image"
image=$(cat "$state_dir/previous.image")
require_digest_reference "$component rollback image" "$image"
set_component_image "$component" "$image"
if [ "$component" = backend ]; then
    backend_services='backend worker'
    if account_mail_enabled; then backend_services="$backend_services mail-worker"; fi
    if media_processor_enabled; then backend_services="$backend_services media-processor"; fi
    if ocr_preview_enabled; then backend_services="$backend_services ocr-preview"; fi
    # shellcheck disable=SC2086
    compose pull $backend_services
    BACKEND_VERSION=$(image_package_version "$image")
    require_semver rollback-backend-version "$BACKEND_VERSION"
    export BACKEND_VERSION
    # shellcheck disable=SC2086
    compose up -d --no-deps $backend_services
else
    compose pull "$component"
    compose up -d --no-deps "$component"
fi
MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/verify.sh" --component "$component"
persist_images
printf '%s\n' rolled-back >"$state_dir/rollback-status"
echo "$component image was rolled back; PostgreSQL state was not changed"
