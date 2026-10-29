#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

load_deploy_environment
take_lock
probe_name=meal-proxy-probe
allowed_ip=198.51.100.10
blocked_ip=198.51.100.11
cleanup() { docker rm -f "$probe_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
cleanup

old_ifs=$IFS
IFS=,
for cidr in ${TRUSTED_PROXY_CIDRS:-}; do
    IFS=$old_ifs
    printf '%s\n' "$cidr" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/32$' || {
        echo "Trusted proxy entries must be exact IPv4 /32 values" >&2; exit 77;
    }
    compose run -d --no-deps --service-ports --name "$probe_name" \
        -e TRUSTED_PROXY_CIDRS="$cidr" -e ADMIN_ALLOWED_IPS="$allowed_ip" backend >/dev/null
    attempts=30
    ready=false
    while [ "$attempts" -gt 0 ]; do
        if curl --fail --silent --max-time 3 http://127.0.0.1:3001/health/live >/dev/null 2>&1; then
            ready=true
            break
        fi
        attempts=$((attempts - 1))
        sleep 1
    done
    if [ "$ready" != true ]; then cleanup; IFS=,; continue; fi
    allowed_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
        --header "X-Forwarded-For: $allowed_ip" http://127.0.0.1:3001/api/v1/admin/auth/status)
    blocked_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
        --header "X-Forwarded-For: $blocked_ip" http://127.0.0.1:3001/api/v1/admin/auth/status)
    cleanup
    if [ "$allowed_status" != 403 ] && [ "$blocked_status" = 403 ]; then
        echo "Runtime proxy source verified by admin guard: $cidr"
        trap - EXIT HUP INT TERM
        exit 0
    fi
    IFS=,
done
IFS=$old_ifs
echo "No configured exact gateway reproduced trusted proxy behavior through the published backend port" >&2
exit 77
