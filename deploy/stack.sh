#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

action=${1:-}
load_deploy_environment
validate_images

case "$action" in
    up)
        take_lock
        validate_network_route meal-db "$MEAL_NETWORK_SUBNET"
        validate_network_route meal-egress "$MEAL_EGRESS_SUBNET"
        if media_infra_enabled; then
            validate_network_route meal-media "$MEAL_MEDIA_SUBNET"
            verify_media_host_storage
        fi
        compose config --quiet
        compose up -d
        ;;
    stop)
        take_lock
        compose stop --timeout 120
        ;;
    status)
        compose ps
        ;;
    *)
        echo "usage: stack.sh <up|stop|status>" >&2
        exit 64
        ;;
esac
