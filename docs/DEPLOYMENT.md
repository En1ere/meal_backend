# Тестовый production-стенд

Актуально на 28 октября 2026 года. Стенд предназначен для интеграционной и ручной приёмки, а не для публичного коммерческого запуска. Этот runbook не содержит паролей, TOTP secret, recovery-кодов, connection strings и содержимого env-файлов.

## Быстрая карта деплоя

1. Код, миграции и общий Compose меняются только в `meal_backend`; серверный control plane лежит в `deploy/`.
2. Push в `main` запускает `.github/workflows/deploy.yml`: quality gate → `ghcr.io/en1ere/meal_backend:sha-<full-sha>` → immutable `@sha256:` → Environment `test`.
3. Workflow вызывает `sudo /usr/local/sbin/meal-deploy backend <image@digest> <git-sha>`. Source/dist в `/srv/meal/backend` больше не копируются: runtime загружается из GHCR.
4. На VPS: `/srv/meal/deployment` — scripts/Compose, `/etc/meal-planner/deploy.env` — non-secret settings, `/etc/meal-planner/secrets` — Docker secrets, `/var/lib/meal-planner/deployments` — digests/evidence. Secrets принадлежат `root:meal-secrets`, имеют mode `0640`, а непривилегированные backend/migrate получают только supplemental GID `29001`. `meal-planner-compose.service` поднимает текущие digests после reboot без автомиграций.
5. Backend доступен только на `127.0.0.1:3001`; host Nginx из `deploy/nginx/meal-planner.conf` отдаёт `/api/` и `/health/`. Smoke: local/public `/health/live` и `/health/ready`.
6. Обычный rollout сам делает backup, migration/grants и verify. Первый перенос host PostgreSQL выполняет только `bootstrap-restore.sh` после fresh backup и остановки writers.
7. Backend rollback после migration разрешён только с root-owned compatibility evidence; БД автоматически не откатывается.

## Адреса и сетевые границы

| Компонент                         | Адрес                                                     |
| --------------------------------- | --------------------------------------------------------- |
| Пользовательское приложение       | `https://abstract-usable-gazebo.ruweb.place`              |
| Административное приложение       | `https://admin.abstract-usable-gazebo.ruweb.place`        |
| API через пользовательский origin | `https://abstract-usable-gazebo.ruweb.place/api/v1`       |
| Liveness                          | `https://abstract-usable-gazebo.ruweb.place/health/live`  |
| Readiness                         | `https://abstract-usable-gazebo.ruweb.place/health/ready` |

Оба интерфейса используют same-origin `/api`; прямые порты Node.js и PostgreSQL из интернета недоступны. Backend слушает `127.0.0.1:3001`, frontend — `127.0.0.1:3000`, PostgreSQL — loopback. UFW разрешает только OpenSSH и `Nginx Full`. Админка вынесена на отдельный origin, потому что её абсолютные маршруты пересекаются с маршрутами пользовательского приложения.

## Подтверждённый release inventory

| Компонент | Активный release                                           | Версия на стенде             | Runtime                              |
| --------- | ---------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| Backend   | `/srv/meal/backend/releases/20261028-0705-0.0.128`         | `0.0.128`                    | `meal-backend.service`, порт `3001`  |
| Frontend  | `/srv/meal/frontend/releases/20261028-0735-0.0.28-0.0.137` | root `0.0.28`, app `0.0.137` | `meal-frontend.service`, порт `3000` |
| Admin     | `/srv/meal/admin/releases/20261028-0757-0.0.117`           | `0.0.117`                    | Nginx static SPA                     |

`current` каждого приложения — symlink на immutable release directory. Candidate нельзя считать развёрнутым, пока `current`, systemd/process environment и post-deploy smoke не подтверждают одну и ту же версию. Repository revision `0.0.132` содержит подготовленную, но ещё не применённую Docker/CI инфраструктуру; исполняемый backend на стенде остаётся проверенным release `0.0.128` до отдельного cutover.

Для каждого следующего выпуска журналируйте вне секретов: source revision, версии package manifests, UTC deploy time, release path, SHA-256 загруженного artifact и предыдущий symlink target. Отсутствие этих данных блокирует переключение.

## Размещение и конфигурация

- ОС: Ubuntu 24.04, Node.js 24, npm 11, PostgreSQL 18, Nginx и systemd.
- Backend: `/srv/meal/backend/current`, сервис `meal-backend.service`.
- Frontend: `/srv/meal/frontend/current`, сервис `meal-frontend.service`.
- Admin: `/srv/meal/admin/current/build`, статическая выдача Nginx со SPA fallback.
- Backend env: `/etc/meal-planner/backend.env`, владелец `root:meal`, mode `0640`.
- Nginx site: `/etc/nginx/sites-available/meal-planner`, source template `deploy/nginx/meal-planner.conf`.
- TLS: Let's Encrypt для основного и admin-домена, продление Certbot.
- Baseline backup до первого deployment: `/var/backups/meal-planner/predeploy-20261027-0515.dump`, root-only.
- Свежий backup непосредственно перед schema v29: `/var/backups/meal-planner/pre-migration029-20261028-0710.dump`, `2,114,768` bytes, SHA-256 `85b25e20540b759e0ec0f225a4f149dbc063a4f152afcc9b57222f9402da8ec4`, `root:root`, mode `0600`.

Backend environment задаёт как минимум имена `NODE_ENV`, `PORT`, `HOST`, `FRONTEND_ORIGIN` и `ADMIN_FRONTEND_ORIGIN`. Секреты задаются либо прямыми `DATABASE_URL`, `SECURITY_KEY`, `MFA_ENCRYPTION_KEY`, либо взаимоисключающими абсолютными `DATABASE_URL_FILE`, `SECURITY_KEY_FILE`, `MFA_ENCRYPTION_KEY_FILE`. Значения проверяются на сервере без печати в терминал или журнал CI. Внешние provider-переменные остаются unset, пока соответствующий provider не принят; интеграции обязаны завершаться fail-closed.

### Runtime-роли БД

На стенде подтверждена цепочка: `meal_runtime` — `LOGIN`, `INHERIT`, без `SUPERUSER`, `CREATEDB`, `CREATEROLE` и `BYPASSRLS`; она состоит в `meal_app` с `inherit_option=true`, `set_option=true`, `admin_option=false`. `meal_app` не имеет повышенных атрибутов и сама настроена с `NOINHERIT`. Application URI обязан передавать connection option `-c role=meal_app` (URL-encoded в query `options`), поэтому login остаётся `session_user=meal_runtime`, а все запросы и readiness выполняются как `current_user=meal_app`. Секретную URI нельзя печатать или сохранять в Git.

Перед каждым release повторно проверьте системный каталог и фактическую сессию из того же `DATABASE_URL`, не выводя его:

```sql
select session_user, current_user;
select current_setting('search_path');
select current_setting('server_version_num')::int / 10000 as server_major;
select has_schema_privilege(current_user, 'meal', 'USAGE') as meal_usage;
select has_schema_privilege(current_user, 'meal', 'CREATE') as meal_create;
```

Требования: PostgreSQL major `18`, `session_user=meal_runtime`, `current_user=meal_app`, `meal_usage=true`, `meal_create=false`, `search_path` начинается с `meal, public`, обе роли не owner/superuser и фактические grants совпадают с `database/application-grants.sql`. Членство проверяется из `pg_auth_members` привилегированной read-only сессией без вывода password/hash. Расхождение блокирует deployment.

## Сборка release artifact

Сборка выполняется из чистого checkout нужной revision на Node.js/npm версий из `package.json`:

```sh
npm ci
npm run check
npm run build
npm audit --omit=dev --audit-level=high
```

Artifact должен включать `dist`, production manifests/lock и файлы, необходимые `npm ci --omit=dev`; `.env`, `.local`, test reports, coverage, локальные backups и credentials исключаются. До отправки вычислите SHA-256 архива, после загрузки пересчитайте его на VPS и сравните. Release directory создаётся новым; существующий release не перезаписывается.

## Docker Compose cutover и автодеплой

`deploy/compose.production.yml` является владельцем общего контейнерного стека: PostgreSQL 18, backend, frontend и admin. Host Nginx остаётся TLS-edge первого cutover и обращается только к `127.0.0.1:3001`, `127.0.0.1:3000` и `127.0.0.1:3002`. PostgreSQL не публикует порт. PostgreSQL 18 volume монтируется только в `/var/lib/postgresql`, без legacy `PGDATA=/var/lib/postgresql/data`; mount старого PGDATA запрещён. `meal-db` использует explicit `172.30.0.0/24` и остаётся изолированной сетью БД; `meal-egress` использует explicit `172.31.0.0/24` и даёт приложениям outbound access. Bootstrap сверяет оба subnet с фактическими Docker networks и host routes до создания. При конфликте оператор обязан выбрать и зафиксировать другой свободный subnet, а не продолжать rollout. Все четыре image references обязаны иметь форму `registry/name@sha256:<digest>`.

Host Nginx приходит на published backend port через Docker bridge gateway. `TRUSTED_PROXY_CIDRS` не может содержать широкую RFC1918-сеть. Runtime smoke первого container cutover доказал admin-guard поведением, что фактический source — только `172.31.0.1/32`; internal `meal-db` gateway контейнеру не назначен и не доверяется. Post-deploy verify отбрасывает отсутствующие/невалидные gateway, сверяет точный список и сохраняет evidence в `proxy-smoke.txt`. Ни один непроверенный proxy CIDR не принимается. После изменения Docker route/network topology проверка выполняется заново.

Первый перенос запрещает bind существующего PGDATA. После создания и проверки свежего dump оператор вручную останавливает host writers `meal-backend.service`, `meal-frontend.service` и host `postgresql.service`; bootstrap сам ничего не останавливает и fail-closed, пока любой unit остаётся active/activating/reloading. Nginx может оставаться TLS-edge. Затем оператор создаёт новый named volume и запускает:

```sh
sh deploy/bootstrap-restore.sh --dump /approved/path/baseline.dump --sha256 <approved-lowercase-sha256>
```

Скрипт отказывается работать с непустой schema, создаёт `meal_app NOLOGIN` и `meal_runtime LOGIN INHERIT`, восстанавливает dump в PostgreSQL 18 с `--no-owner`, применяет grants и до запуска application traffic требует `29/209/483/18` для migrations/tables/FK/PostgreSQL major. Runtime password читается из отдельного root-owned Docker secret. Backend URL также хранится отдельным secret и содержит URL-encoded connection option `-c role=meal_app`.

Проверенный pre-container backup: `/var/backups/meal-planner/pre-container-20261028T125808Z.dump`, `1,770,608` bytes, SHA-256 `b84bbfa3096e3f2f9faaf660a13070ab97f22e6a82b2192ed94019012a92c9fc`, `root:root`, mode `0600`. Restore drill выполнен pinned image `postgres@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8`: schema/history/tables/FK `29/209/483`, environment `test`, users `1`, MFA factors `1`, recipes `0`. Evidence `/var/backups/meal-planner/pre-container-20261028T125808Z.restore-drill.txt` имеет SHA-256 `e18578e25aa6c410249dde879eacea96b9e5c082f20807babcb1f9f067f7f1fa`, `root:root`, mode `0600`. Drill подтвердил, что PostgreSQL 18 отказывается от legacy mount `/var/lib/postgresql/data`; рабочий контракт использует единый volume `/var/lib/postgresql`.

После cutover каждый repository workflow вызывает общий helper только для своего компонента:

```sh
sh /srv/meal/deployment/deploy.sh --component backend --image registry/name@sha256:<digest> --revision <git-sha>
sh /srv/meal/deployment/deploy.sh --component frontend --image registry/name@sha256:<digest> --revision <git-sha>
sh /srv/meal/deployment/deploy.sh --component admin --image registry/name@sha256:<digest> --revision <git-sha>
```

Только backend rollout создаёт backup, останавливает backend writer, запускает one-shot migration и повторно применяет grants. Frontend/admin rollout не подключается к БД и не перезапускает посторонние сервисы. Успешный digest атомарно сохраняется в root-owned `images.env`; failed UI candidate возвращает предыдущий digest компонента. Backend после применённой миграции fail-closed: application rollback разрешён только при `ALLOW_BACKEND_AUTO_ROLLBACK=true` и отдельном root-owned compatibility evidence file, содержащем точные `previous_image=...`, `candidate_image=...` и `schema_version=29`; БД никогда не восстанавливается автоматически. Все rollout-ы сериализованы общим `flock`.

Root-owned `deploy/meal-deploy` устанавливается как `/usr/local/sbin/meal-deploy` mode `0755`, а `deploy/meal-deploy.sudoers` — через `visudo -cf` в `/etc/sudoers.d/meal-deploy` mode `0440`. Единственная группа `meal-deploy` получает право вызвать wrapper; он принимает ровно три positional аргумента, проверяет component, полный Git SHA и allowlisted GHCR repository, после чего передаёт значения flag-based helper без shell evaluation. Общий shell/root доступ CI user не выдаётся.

## Legacy systemd deployment

Этот порядок нужен только для аварийного возврата к доконтейнерному release. Обычный rollout после Docker cutover выполняет `deploy/deploy.sh` из проверенного digest, а не symlink-процедура ниже.

1. Зафиксировать предыдущий target `/srv/meal/backend/current`, версии всех трёх приложений и health status.
2. Проверить свободное место, активные сессии, PostgreSQL logs и отсутствие незавершённого предыдущего rollout.
3. Создать свежий custom-format backup, проверить `pg_restore --list`, размер и SHA-256. Для schema-changing release выполнить restore drill в отдельной БД.
4. Распаковать проверенный artifact в `/srv/meal/backend/releases/<release-id>`, выставить владельца `meal:meal`; не менять `current`.
5. В release directory выполнить `npm ci --omit=dev` и read-only `npm run db:plan` с production-like environment.
6. Сверить migration manifest. Сначала переключить совместимые admin/frontend, затем снять свежий backup и остановить writers. Миграции применять владельцем только после отдельного разрешения: `npm run db:migrate -- --environment=test`. Migration 029 обязана выполняться одной транзакцией с `SERIALIZABLE`; стандартный `READ COMMITTED` корректно завершается fail-closed. Seed при старте API не выполняется.
7. Проверить runtime-role и `search_path` запросами выше. Затем проверить release командой `node dist/src/export-openapi.js` либо заранее сверенным OpenAPI artifact без изменения работающего процесса.
8. Остановить только backend, атомарно переключить `current` на новый release, выполнить `systemctl daemon-reload` при изменении unit и запустить `meal-backend.service`.
9. Дождаться `active`, затем проверить local `/health/live`, `/health/ready` и те же endpoints через HTTPS. Readiness `503` запрещает продолжение.
10. Выполнить post-deploy smoke ниже. Только после него release считается активным; прежний release и backup сохраняются до завершения окна наблюдения.

Миграции обязаны быть совместимыми с предыдущим runtime на время переключения. Если rollback приложения требует отката данных/DDL, автоматический symlink rollback запрещён: остановите rollout и используйте отдельно согласованный recovery plan.

## Post-deploy smoke

```sh
systemctl is-active nginx
systemctl is-inactive meal-backend.service meal-frontend.service postgresql.service
set -a
. /etc/meal-planner/deploy.env
. /var/lib/meal-planner/deployments/images.env
set +a
docker compose -f /srv/meal/deployment/compose.production.yml ps
curl --fail --silent http://127.0.0.1:3001/health/live
curl --fail --silent http://127.0.0.1:3001/health/ready
curl --fail --silent http://127.0.0.1:3000/healthz
curl --fail --silent http://127.0.0.1:3002/healthz
curl --fail --silent https://abstract-usable-gazebo.ruweb.place/health/live
curl --fail --silent https://abstract-usable-gazebo.ruweb.place/health/ready
curl --fail --silent --output /dev/null https://abstract-usable-gazebo.ruweb.place/
curl --fail --silent --output /dev/null https://admin.abstract-usable-gazebo.ruweb.place/
docker compose -f /srv/meal/deployment/compose.production.yml logs --since 15m
nginx -t
ufw status verbose
```

После технического smoke вручную проверить frontend login/logout и один authenticated read, затем admin password → обязательный TOTP → dashboard и logout. Не помещайте пароль, TOTP seed, recovery code, session cookie или response с PII в evidence. Mutation smoke выполняйте только на namespace тестового аккаунта с заранее описанной очисткой.

### Evidence rollout 2026-10-28

- backend `0.0.128` / schema v29 и frontend root/app `0.0.28`/`0.0.137` остаются активны; после базового clients-first rollout текущая admin обновлена до `0.0.117` без изменения wire-контрактов;
- `APP_VERSION` фактического backend process равен `0.0.128`;
- schema history содержит 29 строк, checksum migration 029 равен `ff1d7f9d9a6d4a0ddc20ba9a8e9746029d534a74f5dba19e546b9f32633df98f`;
- подтверждены 209 таблиц, 483 внешних ключа, валидные lifecycle constraints/indexes/triggers и отсутствие нарушений active-publication/case invariants;
- `meal-backend.service`, `meal-frontend.service`, Nginx и PostgreSQL активны, Nginx config валиден; при повторной проверке 28 октября legacy process возвращает `404` для local `/health/live` и `/health/ready`, хотя `/api/v1/auth/csrf` и `/api/v1/admin/auth/csrf` отвечают `200`; Docker cutover заблокирован до успешного candidate health smoke;
- UFW разрешает только OpenSSH и `Nginx Full`; на файловой системе доступно около `27G`;
- frontend authenticated read, recipe list, обе theme switcher и admin password → обязательный MFA прошли без browser console errors;
- frontend root/app `0.0.28`/`0.0.137` дополнительно прошёл read-only desktop/mobile production acceptance `24/24`: mutation requests `0`, runtime errors `0`. Исправленный online API/session startup не зависит от готовности best-effort offline Service Worker.
- admin `0.0.117` подтверждён на root и `/admin/queues/recipes` с `200`; парольный этап доходит до обязательной MFA-границы, а темы `coffee-light` / `nature-dark` переключаются без runtime-ошибок.

## Rollback

1. Запретить новые мутации или остановить backend, если целостность данных под вопросом.
2. Для frontend/admin вызвать `deploy/rollback.sh --component <component>`: helper вернёт предыдущий immutable digest и повторит health-check.
3. Для backend сначала проверить совместимость previous digest с уже применённой схемой. Автоматический rollback разрешён только с точным root-owned compatibility evidence; иначе rollout останавливается fail-closed.
4. Повторить local/public health, login/read smoke и `docker compose ps`; только после этого возобновлять приёмку.
5. Сохранить failed digest, журналы, request IDs и deploy metadata для анализа; не изменять image на месте.

Восстановление БД из backup — отдельная destructive-операция. Оно выполняется только после остановки writers, подтверждения точного source/target и проверки restore в изолированной БД по `docs/backup-recovery.md`.

## Наблюдение и обслуживание

```sh
set -a
. /etc/meal-planner/deploy.env
. /var/lib/meal-planner/deployments/images.env
set +a
docker compose -f /srv/meal/deployment/compose.production.yml ps
docker compose -f /srv/meal/deployment/compose.production.yml logs --since 1h
docker stats --no-stream
df -h / /srv /var/backups
journalctl --disk-usage
certbot renew --dry-run
```

На время soak контролируйте RSS/CPU/restarts Node.js, PostgreSQL connections/long transactions/temp/WAL и свободное место. Настройки log rotation и retention должны быть проверены отдельно. Пакетные обновления и требуемая перезагрузка ОС выполняются в согласованное окно после свежего backup и проверки rollback, не во время ручной приёмки.

## Тестовый аккаунт и очистка

На стенде есть один активный подтверждённый аккаунт с frontend email `admin@meal-planner.test`, admin login `admin`, отображаемым именем `Test Administrator` и обязательным admin TOTP. Секреты передаются владельцу отдельно; при утрате TOTP factor перевыпускается, а не отключается.

Тестовые записи помечаются уникальным run namespace. После smoke удаляйте только записи этого namespace проверенным cleanup или восстанавливайте заранее снятый baseline после отдельного подтверждения. Затем сверяйте baseline counters, 29 migration rows, справочники, отсутствие временных ролей/БД/locks и чистый `db:plan`. Для v29 отдельно проверьте backfill `recipe_publications.recipe_id`, включённые `protect_identity`/compatibility triggers и отсутствие дублирующих active publications. Подробные сценарии: `docs/DATABASE_TESTING.md` и `docs/BACKEND_TESTING.md`.

## Известные production gates

- Юридические документы имеют `draft_blocked`; публичный коммерческий релиз запрещён.
- Off-host immutable backups, retention и утверждённые RPO/RTO не подтверждены.
- Payment, production email/push, AI, external storage и scanner не настроены и должны оставаться fail-closed.
- Нужны capacity/OOM/worker soak, обоснованный pool limit, external log/alert sink и проверенная ротация.
- На VPS доступны обновления ОС и требуется согласованное reboot window.
- Сквозной revision-aware lifecycle рецепта реализован и развёрнут; mutation acceptance с новым тестовым namespace всё равно выполняется только при доступном валидном admin MFA и с точной cleanup-процедурой.
- Production-readiness manifests и browser validator принадлежат frontend-репозиторию; backend подтверждает только собственные DB/worker/legal gates. Команды отсутствующего validator из этого репозитория запускать нельзя.
