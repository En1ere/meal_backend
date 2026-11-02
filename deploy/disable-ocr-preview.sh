#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 77; }
load_deploy_environment
[ "${OCR_PREVIEW_ENABLED:-false}" = false ] || {
    echo "Set OCR_PREVIEW_ENABLED=false in deploy.env before disabling the sidecar" >&2
    exit 77
}
require_file "$OCR_PREVIEW_COMPOSE_FILE"
take_lock

OCR_PREVIEW_ENABLED=true
export OCR_PREVIEW_ENABLED
compose stop --timeout 30 ocr-preview
compose rm -f ocr-preview

OCR_PREVIEW_ENABLED=false
export OCR_PREVIEW_ENABLED
compose up -d --no-deps --force-recreate backend
MEAL_LOCK_HELD=1 sh "$SCRIPT_DIR/verify.sh" --component backend

backend_id=$(compose ps -q backend)
backend_networks=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$backend_id")
if printf '%s\n' "$backend_networks" | grep -Fqx meal-ocr; then
    echo "Backend remained attached to the OCR preview network" >&2
    exit 77
fi
echo "OCR preview stopped and backend detached; token was preserved"
