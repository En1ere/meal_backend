#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

component=all
while [ "$#" -gt 0 ]; do
    case "$1" in --component) component=${2:-}; shift 2 ;; *) echo "Unknown argument: $1" >&2; exit 64 ;; esac
done
case "$component" in all|backend|frontend|admin) ;; *) echo "Unsupported component" >&2; exit 64 ;; esac
load_deploy_environment

wait_http() {
    name=$1 url=$2 attempts=${3:-30}
    while [ "$attempts" -gt 0 ]; do
        if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then return 0; fi
        attempts=$((attempts - 1)); sleep 2
    done
    echo "$name did not become healthy" >&2; return 1
}
require_running() {
    container_id=$(compose ps -q "$1")
    test -n "$container_id" || { echo "$1 container is missing" >&2; exit 1; }
    test "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true || {
        echo "$1 container is not running" >&2; exit 1;
    }
}
wait_healthy() {
    health_service=$1
    health_attempts=${2:-45}
    while [ "$health_attempts" -gt 0 ]; do
        health_container_id=$(compose ps -q "$health_service")
        if [ -n "$health_container_id" ]; then
            health_running=$(docker inspect --format '{{.State.Running}}' "$health_container_id" 2>/dev/null || true)
            health_status=$(docker inspect --format '{{.State.Health.Status}}' "$health_container_id" 2>/dev/null || true)
            [ "$health_running" = true ] || break
            [ "$health_status" = healthy ] && return 0
        fi
        health_attempts=$((health_attempts - 1))
        sleep 2
    done
    echo "$health_service container did not become healthy" >&2
    return 1
}

case "$component" in
    backend)
        require_running postgres; require_running backend; wait_healthy worker
        if account_mail_enabled; then wait_healthy mail-worker; fi
        wait_http backend-live http://127.0.0.1:3001/health/live
        wait_http backend-ready http://127.0.0.1:3001/health/ready ;;
    frontend) require_running frontend; wait_http frontend http://127.0.0.1:3000/healthz ;;
    admin) require_running admin; wait_http admin http://127.0.0.1:3002/healthz ;;
    all)
        require_running postgres; require_running backend; wait_healthy worker; require_running frontend; require_running admin
        if account_mail_enabled; then wait_healthy mail-worker; fi
        wait_http backend-live http://127.0.0.1:3001/health/live
        wait_http backend-ready http://127.0.0.1:3001/health/ready
        wait_http frontend http://127.0.0.1:3000/healthz
        wait_http admin http://127.0.0.1:3002/healthz ;;
esac
if [ "$component" = backend ] || [ "$component" = all ]; then
    backend_id=$(compose ps -q backend)
    backend_mounts=$(docker inspect --format '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$backend_id")
    observability_mount='/var/lib/meal-planner/observability /run/meal-observability false'
    [ "$(printf '%s\n' "$backend_mounts" | grep -Fxc "$observability_mount" || true)" -eq 1 ] || {
        echo "Backend observability directory must have one exact read-only mount" >&2
        exit 77
    }
    [ -d /var/lib/meal-planner/observability ] && [ ! -L /var/lib/meal-planner/observability ] && \
        [ "$(stat -c '%u %g %a' /var/lib/meal-planner/observability)" = '0 29002 2750' ] || {
        echo "Host observability directory metadata is unsafe; bootstrap it before rollout" >&2
        exit 77
    }
    application_services='backend worker frontend admin postgres'
    if account_mail_enabled; then application_services="$application_services mail-worker"; fi
    for application_service in $application_services; do
        application_id=$(compose ps -q "$application_service")
        [ -z "$application_id" ] && continue
        application_mounts=$(docker inspect --format '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$application_id")
        if printf '%s\n' "$application_mounts" | grep -Fq 'docker.sock'; then
            echo "$application_service must not mount the Docker socket" >&2
            exit 77
        fi
        if [ "$application_service" != backend ] && printf '%s\n' "$application_mounts" | grep -Eq '/var/lib/meal-planner/observability|/run/meal-observability'; then
            echo "$application_service must not mount observability data" >&2
            exit 77
        fi
    done
    case "${OBSERVABILITY_HOST_SNAPSHOT_ENABLED:-true}" in
        true)
            compose exec -T backend node --input-type=module -e "const {HostSnapshotReader}=await import('./dist/src/modules/admin-observability/host-snapshot.reader.js');const snapshot=await new HostSnapshotReader('/run/meal-observability/current.json').read();if(snapshot.freshness.state!=='fresh'||!['ok','partial'].includes(snapshot.collectorStatus))process.exit(1)" || {
                echo "Enabled host observability snapshot is not safely readable" >&2
                exit 77
            }
            ;;
        false) printf '%s\n' 'Host observability is explicitly disabled; safe read-only mount remains required and snapshot may be absent' ;;
        *) echo "OBSERVABILITY_HOST_SNAPSHOT_ENABLED must be true or false" >&2; exit 64 ;;
    esac
    gateways=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{if .Gateway}}{{.Gateway}}{{"\n"}}{{end}}{{end}}' "$backend_id" \
        | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | sort -u)
    expected=$(printf '%s\n' "$gateways" | sed '/^$/d;s/$/\/32/' | sort | paste -sd, -)
    configured=$(printf '%s' "${TRUSTED_PROXY_CIDRS:-}" | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)
    [ -n "$expected" ] && [ "$configured" = "$expected" ] || {
        echo "TRUSTED_PROXY_CIDRS must equal the exact Docker gateway /32 addresses" >&2
        exit 77
    }
    printf 'Trusted proxy gateways verified: %s\n' "$configured"
fi
[ "$component" != backend ] && [ "$component" != all ] || [ -z "${PUBLIC_ORIGIN:-}" ] || wait_http public-ready "$PUBLIC_ORIGIN/health/ready" 15
[ "$component" != frontend ] && [ "$component" != all ] || [ -z "${PUBLIC_ORIGIN:-}" ] || wait_http public-frontend "$PUBLIC_ORIGIN/" 15
[ "$component" != admin ] && [ "$component" != all ] || [ -z "${ADMIN_PUBLIC_ORIGIN:-}" ] || wait_http public-admin "$ADMIN_PUBLIC_ORIGIN/" 15
echo "$component deployment verification passed"
