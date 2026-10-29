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
require_healthy() {
    require_running "$1"
    container_id=$(compose ps -q "$1")
    test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy || {
        echo "$1 container is not healthy" >&2; exit 1;
    }
}

case "$component" in
    backend)
        require_running postgres; require_running backend; require_healthy worker
        wait_http backend-live http://127.0.0.1:3001/health/live
        wait_http backend-ready http://127.0.0.1:3001/health/ready ;;
    frontend) require_running frontend; wait_http frontend http://127.0.0.1:3000/healthz ;;
    admin) require_running admin; wait_http admin http://127.0.0.1:3002/healthz ;;
    all)
        require_running postgres; require_running backend; require_healthy worker; require_running frontend; require_running admin
        wait_http backend-live http://127.0.0.1:3001/health/live
        wait_http backend-ready http://127.0.0.1:3001/health/ready
        wait_http frontend http://127.0.0.1:3000/healthz
        wait_http admin http://127.0.0.1:3002/healthz ;;
esac
if [ "$component" = backend ] || [ "$component" = all ]; then
    backend_id=$(compose ps -q backend)
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
