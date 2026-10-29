#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

MAIL_PASSWORD_FILE=${MAIL_RUNTIME_DATABASE_PASSWORD_FILE:-/etc/meal-planner/secrets/mail-runtime-database-password}
MAIL_URL_FILE=${MAIL_WORKER_DATABASE_URL_FILE:-/etc/meal-planner/secrets/mail-worker-database-url}

load_deploy_environment
take_lock
require_file "$MAIL_PASSWORD_FILE"
[ "$(stat -c %u "$MAIL_PASSWORD_FILE")" = 0 ] || { echo "Mail database password must be root-owned" >&2; exit 77; }
case "$(stat -c %a "$MAIL_PASSWORD_FILE")" in 600|640) ;; *) echo "Mail database password mode must be 0600 or 0640" >&2; exit 77 ;; esac
mail_password=$(cat "$MAIL_PASSWORD_FILE")
printf '%s\n' "$mail_password" | grep -Eq '^[0-9a-f]{64}$' || {
    echo "Mail database password must be a random 32-byte lowercase hex value" >&2
    exit 65
}

postgres_id=$(compose ps -q postgres)
[ -n "$postgres_id" ] || { echo "PostgreSQL container is not running" >&2; exit 69; }
container_secret="/tmp/meal-mail-runtime-password.$$"
trap 'docker exec --user root "$postgres_id" rm -f "$container_secret" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker cp "$MAIL_PASSWORD_FILE" "$postgres_id:$container_secret"
docker exec --user root "$postgres_id" chown postgres:postgres "$container_secret"
docker exec --user root "$postgres_id" chmod 0600 "$container_secret"
docker exec --user postgres "$postgres_id" sh -ec '
  mail_password=$(cat "$1")
  exec psql --username "$POSTGRES_USER" --dbname meal_planner_postgres --no-password \
    --set ON_ERROR_STOP=1 --set mail_password="$mail_password"
' sh "$container_secret" <<'SQL'
select 'create role meal_mail_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls'
where not exists(select 1 from pg_roles where rolname='meal_mail_worker') \gexec
select 'create role meal_mail_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls'
where not exists(select 1 from pg_roles where rolname='meal_mail_runtime') \gexec
alter role meal_mail_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role meal_mail_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'mail_password';
revoke meal_app from meal_mail_runtime;
grant meal_mail_worker to meal_mail_runtime with inherit false, set true;
grant connect on database meal_planner_postgres to meal_mail_runtime;
SQL

role_facts=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres --no-password --tuples-only --no-align --field-separator / --command "
select login.rolcanlogin,login.rolinherit,worker.rolcanlogin,worker.rolinherit,
 exists(select 1 from pg_auth_members m where m.roleid=worker.oid and m.member=login.oid and not m.inherit_option and m.set_option),
 not exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid where m.member=login.oid and granted.rolname='meal_app')
from pg_roles login cross join pg_roles worker
where login.rolname='meal_mail_runtime' and worker.rolname='meal_mail_worker';")
[ "$role_facts" = "t/f/f/f/t/t" ] || { echo "Mail runtime role chain mismatch" >&2; exit 65; }

secret_dir=$(dirname "$MAIL_URL_FILE")
[ -d "$secret_dir" ] && [ ! -L "$secret_dir" ] || { echo "Mail secret directory is unsafe" >&2; exit 77; }
temporary="$MAIL_URL_FILE.tmp.$$"
umask 077
printf 'postgresql://meal_mail_runtime:%s@postgres:5432/meal_planner_postgres?options=-c%%20role%%3Dmeal_mail_worker\n' "$mail_password" >"$temporary"
chown root:${MEAL_SECRETS_GID:-29001} "$temporary"
chmod 0640 "$temporary"
mv "$temporary" "$MAIL_URL_FILE"
docker exec --user root "$postgres_id" rm -f "$container_secret"
trap - EXIT HUP INT TERM
echo "Dedicated account-mail database login provisioned; application role access is absent"
