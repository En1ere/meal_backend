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
take_lock
state_dir=${state_dir:-$STATE_ROOT/current-$component}
state_dir=$(readlink -f "$state_dir")
case "$state_dir" in "$STATE_ROOT"/*) ;; *) echo "Rollback state must be under $STATE_ROOT" >&2; exit 64 ;; esac
require_file "$state_dir/previous.image"
image=$(cat "$state_dir/previous.image")
require_digest_reference "$component rollback image" "$image"
set_component_image "$component" "$image"
compose pull "$component"
compose up -d --no-deps "$component"
MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/verify.sh" --component "$component"
persist_images
printf '%s\n' rolled-back >"$state_dir/rollback-status"
echo "$component image was rolled back; PostgreSQL state was not changed"
