#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 77; }
load_deploy_environment
media_infra_enabled || { echo "Set MEDIA_STORAGE_INFRA_ENABLED=true first" >&2; exit 64; }
validate_images
take_lock
verify_media_host_storage
validate_network_route meal-media "$MEAL_MEDIA_SUBNET"
compose config --quiet
compose pull seaweedfs
compose up -d --no-deps seaweedfs

run_seaweed_shell() {
    printf '%s\n' "$1" | compose exec -T seaweedfs weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888
}

attempts=30
while [ "$attempts" -gt 0 ]; do
    if run_seaweed_shell cluster.status >/dev/null 2>&1; then
        break
    fi
    attempts=$((attempts - 1))
    sleep 2
done
[ "$attempts" -gt 0 ] || { echo "SeaweedFS did not become ready" >&2; exit 1; }

buckets=$(run_seaweed_shell s3.bucket.list)
for bucket in "${MEDIA_STORAGE_QUARANTINE_BUCKET:-meal-media-quarantine}" \
    "${MEDIA_STORAGE_READY_BUCKET:-meal-media-ready}"; do
    if ! printf '%s\n' "$buckets" | grep -Eq "^  ${bucket}[[:space:]]"; then
        run_seaweed_shell "s3.bucket.create -name=$bucket" >/dev/null
    fi
done

verify_media_host_storage
printf '%s\n' 'Local media provider and private buckets are ready; user media API remains controlled separately by MEDIA_STORAGE_ENABLED'
