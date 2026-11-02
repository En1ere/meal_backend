#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 77; }
load_deploy_environment
[ "${MEDIA_STORAGE_ENABLED:-false}" = false ] || {
    echo "Disable the backend media API and recreate backend before stopping its provider" >&2
    exit 77
}
require_file "$MEDIA_INFRA_COMPOSE_FILE"
require_digest_reference SEAWEEDFS_IMAGE "${SEAWEEDFS_IMAGE:-}"
take_lock

backend_id=$(docker compose -f "$COMPOSE_FILE" -f "$MEDIA_INFRA_COMPOSE_FILE" ps -q backend)
if [ -n "$backend_id" ]; then
    backend_networks=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$backend_id")
    if printf '%s\n' "$backend_networks" | grep -Fqx meal-media; then
        echo "Backend is still attached to meal-media; recreate it with MEDIA_STORAGE_ENABLED=false first" >&2
        exit 77
    fi
fi

docker compose -f "$COMPOSE_FILE" -f "$MEDIA_INFRA_COMPOSE_FILE" stop --timeout 120 seaweedfs
container_id=$(docker compose -f "$COMPOSE_FILE" -f "$MEDIA_INFRA_COMPOSE_FILE" ps -aq seaweedfs)
if [ -n "$container_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ]; then
    echo "SeaweedFS is still running" >&2
    exit 1
fi
echo "Local media provider stopped; encrypted objects and keys were preserved"
