#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

PUSH_PASSWORD_FILE=${WEB_PUSH_RUNTIME_DATABASE_PASSWORD_FILE:-/etc/meal-planner/secrets/web-push-runtime-database-password}
PUSH_URL_FILE=${WEB_PUSH_WORKER_DATABASE_URL_FILE:-/etc/meal-planner/secrets/web-push-worker-database-url}
PUSH_PRIVATE_FILE=${WEB_PUSH_VAPID_PRIVATE_KEY_FILE:-/etc/meal-planner/secrets/web-push-vapid-private-key}
PUSH_SUBSCRIPTION_FILE=${WEB_PUSH_SUBSCRIPTION_KEY_FILE:-/etc/meal-planner/secrets/web-push-subscription-key}

load_deploy_environment
take_lock
[ "$(id -u)" = 0 ] || { echo 'Web Push provisioning requires root' >&2; exit 77; }
secret_dir=$(dirname "$PUSH_PASSWORD_FILE")
[ -d "$secret_dir" ] && [ ! -L "$secret_dir" ] || { echo 'Web Push secret directory is unsafe' >&2; exit 77; }
if [ ! -e "$PUSH_PASSWORD_FILE" ]; then
    umask 077
    openssl rand -hex 32 >"$PUSH_PASSWORD_FILE"
fi
for secret_file in "$PUSH_PASSWORD_FILE" "$PUSH_PRIVATE_FILE" "$PUSH_SUBSCRIPTION_FILE"; do
    require_file "$secret_file"
    [ "$(stat -c %u "$secret_file")" = 0 ] || { echo 'Web Push secret must be root-owned' >&2; exit 77; }
    case "$(stat -c %a "$secret_file")" in 600|640) ;; *) echo 'Web Push secret mode must be 0600 or 0640' >&2; exit 77 ;; esac
done
for runtime_secret in "$PUSH_PRIVATE_FILE" "$PUSH_SUBSCRIPTION_FILE"; do
    [ "$(stat -c %g "$runtime_secret")" = "${MEAL_SECRETS_GID:-29001}" ] || {
        echo 'Web Push runtime secret must use the configured secrets group' >&2; exit 77;
    }
done
push_password=$(tr -d '\r\n' <"$PUSH_PASSWORD_FILE")
private_key=$(tr -d '\r\n' <"$PUSH_PRIVATE_FILE")
subscription_key=$(tr -d '\r\n' <"$PUSH_SUBSCRIPTION_FILE")
printf '%s\n' "$push_password" | grep -Eq '^[0-9a-f]{64}$' || { echo 'Web Push database password must be 32-byte lowercase hex' >&2; exit 65; }
printf '%s\n' "${WEB_PUSH_VAPID_PUBLIC_KEY:-}" | grep -Eq '^[A-Za-z0-9_-]{87}$' || { echo 'Web Push public key is invalid' >&2; exit 65; }
printf '%s\n' "$private_key" | grep -Eq '^[A-Za-z0-9_-]{43}$' || { echo 'Web Push private key is invalid' >&2; exit 65; }
printf '%s\n' "$subscription_key" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || { echo 'Web Push subscription key is invalid' >&2; exit 65; }
unset private_key subscription_key

postgres_id=$(compose ps -q postgres)
[ -n "$postgres_id" ] || { echo 'PostgreSQL container is not running' >&2; exit 69; }
container_secret="/tmp/meal-web-push-runtime-password.$$"
trap 'docker exec --user root "$postgres_id" rm -f "$container_secret" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker cp "$PUSH_PASSWORD_FILE" "$postgres_id:$container_secret"
docker exec --user root "$postgres_id" chown postgres:postgres "$container_secret"
docker exec --user root "$postgres_id" chmod 0600 "$container_secret"
docker exec -i --user postgres "$postgres_id" sh -ec '
  push_password=$(cat "$1")
  exec psql --username "$POSTGRES_USER" --dbname meal_planner_postgres --no-password \
    --set ON_ERROR_STOP=1 --set push_password="$push_password"
' sh "$container_secret" <<'SQL'
select 'create role meal_push_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' where not exists(select 1 from pg_roles where rolname='meal_push_worker') \gexec
select 'create role meal_push_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' where not exists(select 1 from pg_roles where rolname='meal_push_runtime') \gexec
alter role meal_push_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role meal_push_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'push_password';
revoke meal_app,meal_mail_worker,meal_media_worker from meal_push_runtime;
grant meal_push_worker to meal_push_runtime with inherit false,set true;
grant connect on database meal_planner_postgres to meal_push_runtime;
grant usage on schema meal to meal_push_worker;
grant select(id,user_id,priority,category,dedup_key,available_at) on meal.notifications to meal_push_worker;
grant select(user_id,category,channel,enabled,quiet_hours,timezone,urgent_opt_in) on meal.notification_preferences to meal_push_worker;
grant select(id,endpoint_encrypted,keys_encrypted,expiration_time,user_id,session_id,revoked_at) on meal.push_subscriptions to meal_push_worker;
grant select(id,quiet_start,quiet_end,critical_ttl,important_ttl,informational_ttl,marketing_ttl) on meal.web_push_policies to meal_push_worker;
grant select on meal.web_push_jobs to meal_push_worker;
grant select(id,status,archived_at) on meal.users to meal_push_worker;
grant select(id,user_id,revoked_at,expires_at) on meal.sessions to meal_push_worker;
grant select(user_id,scope,revoked_at,starts_at,ends_at) on meal.sanctions to meal_push_worker;
grant select(user_id,kind,action,revision) on meal.legal_consent_events to meal_push_worker;
grant insert on meal.web_push_jobs,meal.web_push_attempts to meal_push_worker;
grant update(state,attempt_count,next_attempt_at,lease_token,lease_until,updated_at,version) on meal.web_push_jobs to meal_push_worker;
grant update(revoked_at,updated_at,version) on meal.push_subscriptions to meal_push_worker;
SQL

role_facts=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" --dbname meal_planner_postgres --no-password --tuples-only --no-align --field-separator / --command "
select login.rolcanlogin,login.rolinherit,worker.rolcanlogin,worker.rolinherit,
 exists(select 1 from pg_auth_members m where m.roleid=worker.oid and m.member=login.oid and not m.inherit_option and m.set_option),
 not exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid where m.member=login.oid and granted.rolname in ('meal_app','meal_mail_worker','meal_media_worker'))
from pg_roles login cross join pg_roles worker where login.rolname='meal_push_runtime' and worker.rolname='meal_push_worker';")
[ "$role_facts" = 't/f/f/f/t/t' ] || { echo 'Web Push runtime role chain mismatch' >&2; exit 65; }

temporary="$PUSH_URL_FILE.tmp.$$"
umask 077
printf 'postgresql://meal_push_runtime:%s@postgres:5432/meal_planner_postgres?options=-c%%20role%%3Dmeal_push_worker\n' "$push_password" >"$temporary"
chown root:"${MEAL_SECRETS_GID:-29001}" "$temporary"
chmod 0640 "$temporary"
mv "$temporary" "$PUSH_URL_FILE"
docker exec --user root "$postgres_id" rm -f "$container_secret"
trap - EXIT HUP INT TERM
echo 'Dedicated Web Push database login provisioned; application/mail/media roles are absent'
