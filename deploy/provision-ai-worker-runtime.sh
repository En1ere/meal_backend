#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

AI_PASSWORD_FILE=${AI_WORKER_RUNTIME_DATABASE_PASSWORD_FILE:-/etc/meal-planner/secrets/ai-worker-runtime-database-password}
AI_URL_FILE=${AI_WORKER_DATABASE_URL_FILE:-/etc/meal-planner/secrets/ai-worker-database-url}
AI_TOKEN_FILE=${AI_API_TOKEN_FILE:-/etc/meal-planner/secrets/ai-api-token}

load_deploy_environment
take_lock
[ "$(id -u)" = 0 ] || { echo 'AI worker provisioning requires root' >&2; exit 77; }
secret_dir=$(dirname "$AI_PASSWORD_FILE")
[ -d "$secret_dir" ] && [ ! -L "$secret_dir" ] || { echo 'AI worker secret directory is unsafe' >&2; exit 77; }
if [ ! -e "$AI_PASSWORD_FILE" ]; then
    umask 077
    openssl rand -hex 32 >"$AI_PASSWORD_FILE"
fi
for secret_file in "$AI_PASSWORD_FILE" "$AI_TOKEN_FILE"; do
    require_file "$secret_file"
    [ "$(stat -c %u "$secret_file")" = 0 ] || { echo 'AI worker secret must be root-owned' >&2; exit 77; }
    case "$(stat -c %a "$secret_file")" in 600|640) ;; *) echo 'AI worker secret mode must be 0600 or 0640' >&2; exit 77 ;; esac
done
[ "$(stat -c %g "$AI_TOKEN_FILE")" = "${MEAL_SECRETS_GID:-29001}" ] || { echo 'AI token must use the configured secrets group' >&2; exit 77; }
ai_password=$(tr -d '\r\n' <"$AI_PASSWORD_FILE")
printf '%s\n' "$ai_password" | grep -Eq '^[0-9a-f]{64}$' || { echo 'AI worker database password is invalid' >&2; exit 65; }
[ -n "$(tr -d '\r\n' <"$AI_TOKEN_FILE")" ] || { echo 'AI API token is empty' >&2; exit 65; }

postgres_id=$(compose ps -q postgres)
[ -n "$postgres_id" ] || { echo 'PostgreSQL container is not running' >&2; exit 69; }
container_secret="/tmp/meal-ai-runtime-password.$$"
trap 'docker exec --user root "$postgres_id" rm -f "$container_secret" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker cp "$AI_PASSWORD_FILE" "$postgres_id:$container_secret"
docker exec --user root "$postgres_id" chown postgres:postgres "$container_secret"
docker exec --user root "$postgres_id" chmod 0600 "$container_secret"
docker exec -i --user postgres "$postgres_id" sh -ec '
  ai_password=$(cat "$1")
  exec psql --username "$POSTGRES_USER" --dbname meal_planner_postgres --no-password \
    --set ON_ERROR_STOP=1 --set ai_password="$ai_password"
' sh "$container_secret" <<'SQL'
select 'create role meal_ai_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' where not exists(select 1 from pg_roles where rolname='meal_ai_worker') \gexec
select 'create role meal_ai_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' where not exists(select 1 from pg_roles where rolname='meal_ai_runtime') \gexec
alter role meal_ai_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role meal_ai_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'ai_password';
revoke meal_app,meal_mail_worker,meal_media_worker from meal_ai_runtime;
grant meal_ai_worker to meal_ai_runtime with inherit false,set true;
grant connect on database meal_planner_postgres to meal_ai_runtime;
grant usage on schema meal to meal_ai_worker;
grant select on meal.ai_operations,meal.ai_operation_attempts,meal.ai_tasks,meal.ai_intervals,meal.ai_messages,
 meal.ai_buckets,meal.ai_ledger,meal.users,meal.sanctions,meal.legal_consent_events,meal.subscriptions,
 meal.billing_products,meal.subscription_periods,meal.grace_incidents,meal.subscription_changes,
 meal.family_memberships,meal.family_coverages to meal_ai_worker;
grant insert on meal.ai_operation_attempts,meal.ai_ledger,meal.ai_messages to meal_ai_worker;
grant update(lifecycle_state,financial_state,failure_category,failure_retryable,next_attempt_at,lease_owner,
 lease_token,lease_until,attempt_count,provider_client_request_id,provider_request_id,actual_model,token_usage,
 service_tier,result_snapshot,provider_cost,provider_cost_state,finished_at,updated_at,version) on meal.ai_operations to meal_ai_worker;
grant update(state,provider_request_id,actual_model,service_tier,input_tokens,output_tokens,reasoning_tokens,
 estimated_cost,actual_cost,error_category,error_code,submitted_at,finished_at,latency_ms) on meal.ai_operation_attempts to meal_ai_worker;
grant update(balance_projection,reserved_projection,version) on meal.ai_buckets to meal_ai_worker;
grant update(status,version) on meal.ai_intervals,meal.ai_tasks to meal_ai_worker;
SQL

temporary="$AI_URL_FILE.tmp.$$"
umask 077
printf 'postgresql://meal_ai_runtime:%s@postgres:5432/meal_planner_postgres?options=-c%%20role%%3Dmeal_ai_worker\n' "$ai_password" >"$temporary"
chown root:"${MEAL_SECRETS_GID:-29001}" "$temporary"
chmod 0640 "$temporary"
mv "$temporary" "$AI_URL_FILE"
docker exec --user root "$postgres_id" rm -f "$container_secret"
trap - EXIT HUP INT TERM
echo 'Dedicated AI worker database login provisioned'
