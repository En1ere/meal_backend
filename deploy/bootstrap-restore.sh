#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

dump= expected_sha256=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dump) dump=${2:-}; shift 2 ;;
        --sha256) expected_sha256=${2:-}; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 64 ;;
    esac
done
require_file "$dump"
printf '%s\n' "$expected_sha256" | grep -Eq '^[0-9a-f]{64}$' || {
    echo "--sha256 must be the approved lowercase SHA-256" >&2; exit 64;
}
actual_sha256=$(sha256sum "$dump" | awk '{print $1}')
[ "$actual_sha256" = "$expected_sha256" ] || { echo "Backup checksum mismatch" >&2; exit 65; }

load_deploy_environment
validate_images
take_lock
validate_network_route meal-db "$MEAL_NETWORK_SUBNET"
validate_network_route meal-egress "$MEAL_EGRESS_SUBNET"
command -v systemctl >/dev/null 2>&1 || { echo "systemd preflight is required for first cutover" >&2; exit 69; }
for unit in meal-backend.service meal-frontend.service postgresql.service; do
    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    case "$state" in
        active|activating|reloading)
            echo "Host writer/runtime $unit is still $state; stop it explicitly before cutover" >&2
            exit 77
            ;;
    esac
done
for service in backend frontend admin; do
    if compose ps --status running --services | grep -qx "$service"; then
        echo "$service must be stopped during first cutover" >&2; exit 77
    fi
done

# This creates a new named volume. Existing host PGDATA is never mounted or reused.
compose up -d postgres
postgres_id=$(compose ps -q postgres)
test -n "$postgres_id" || { echo "PostgreSQL container is missing" >&2; exit 69; }
attempts=30
until compose exec -T postgres pg_isready --username "${POSTGRES_USER:-meal_owner}" --dbname meal_planner_postgres >/dev/null 2>&1; do
    attempts=$((attempts - 1)); [ "$attempts" -gt 0 ] || { echo "PostgreSQL did not become ready" >&2; exit 69; }; sleep 2
done
existing=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres --no-password --tuples-only --no-align \
    --command "select count(*) from information_schema.tables where table_schema='meal'")
[ "$existing" = 0 ] || { echo "Target volume is not empty; restore refused" >&2; exit 77; }

# Provision least-privilege roles without printing the runtime password.
compose exec -T postgres sh -ec '
  runtime_password=$(cat /run/secrets/runtime_database_password)
  exec psql --username "$POSTGRES_USER" --dbname meal_planner_postgres --no-password \
    --set ON_ERROR_STOP=1 --set runtime_password="$runtime_password"
' <<'SQL'
select 'create role meal_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls'
where not exists(select 1 from pg_roles where rolname='meal_app') \gexec
select 'create role meal_runtime login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls'
where not exists(select 1 from pg_roles where rolname='meal_runtime') \gexec
alter role meal_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role meal_runtime login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'runtime_password';
grant meal_app to meal_runtime with inherit true, set true;
SQL

restore_path=/tmp/meal-planner-bootstrap.dump
docker cp "$dump" "$postgres_id:$restore_path"
trap 'docker exec --user root "$postgres_id" rm -f "$restore_path" >/dev/null 2>&1 || true' EXIT HUP INT TERM
# `docker cp` preserves the root-owned, mode 0600 backup. Grant only the
# PostgreSQL process access inside the container before running pg_restore.
docker exec --user root "$postgres_id" chown postgres:postgres "$restore_path"
docker exec --user root "$postgres_id" chmod 0600 "$restore_path"
docker exec --user postgres "$postgres_id" pg_restore --exit-on-error --single-transaction \
    --username "${POSTGRES_USER:-meal_owner}" --no-owner --no-acl \
    --role "${POSTGRES_USER:-meal_owner}" --dbname meal_planner_postgres "$restore_path"

compose --profile tools run --rm --no-deps --entrypoint cat migrate database/application-grants.sql \
    | compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
        --dbname meal_planner_postgres --no-password --set ON_ERROR_STOP=1

facts=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres --no-password --tuples-only --no-align --field-separator / --command "
select
 (select count(*) from meal.schema_migrations),
 (select count(*) from information_schema.tables where table_schema='meal' and table_type='BASE TABLE'),
 (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='meal' and c.contype='f'),
 current_setting('server_version_num')::int/10000;")
[ "$facts" = "29/209/483/18" ] || { echo "Restored database invariant mismatch" >&2; exit 65; }
role_facts=$(compose exec -T postgres psql --username "${POSTGRES_USER:-meal_owner}" \
    --dbname meal_planner_postgres --no-password --tuples-only --no-align --field-separator / --command "
select app.rolcanlogin,app.rolinherit,runtime.rolcanlogin,runtime.rolinherit,
 exists(select 1 from pg_auth_members m where m.roleid=app.oid and m.member=runtime.oid and m.inherit_option and m.set_option)
from pg_roles app cross join pg_roles runtime where app.rolname='meal_app' and runtime.rolname='meal_runtime';")
[ "$role_facts" = "f/f/t/t/t" ] || { echo "Runtime role chain mismatch" >&2; exit 65; }

# Validate the actual secret URI, including `options=-c role=meal_app`, without exposing it.
if ! compose run --rm --no-deps backend node --input-type=module --eval '
  import fs from "node:fs";
  import pg from "pg";
  const connectionString = fs.readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query("select session_user, current_user");
    if (result.rows[0]?.session_user !== "meal_runtime" || result.rows[0]?.current_user !== "meal_app") process.exitCode = 65;
  } finally { await client.end().catch(() => undefined); }
'; then
    echo "Backend database URL does not establish the required role chain" >&2
    exit 65
fi

docker exec --user root "$postgres_id" rm -f "$restore_path"
trap - EXIT HUP INT TERM
persist_images
echo "Fresh PostgreSQL 18 volume restored and verified; application traffic remains stopped"
