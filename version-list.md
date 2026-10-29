# Backend version-list

0.0.150 - 10.29.2026 | 20:15 - Синхронизированы production runbook, OpenAPI metadata и readiness tracker с фактическими автодеплоями: schema v30/миграция 030, 30/212/488 migration/table/FK counts, backend 0.0.149 и admin 0.0.125 evidence, завершённая observability-приёмка. Recovery contract v5, bootstrap restore и reference-data gate теперь fail-closed требуют точную schema v30; технические origins явно отмечены как текущие, custom-domain cutover — pending до DNS. Публичный HTTP API не изменён.

0.0.149 - 10.29.2026 | 17:05 - Добавлен versioned admin acceptance checklist для 83 кейсов БД/backend/admin/frontend: semantic catalog IDs и checksums, отдельный run на catalog version, CAS/idempotency, bounded comments, reset без удаления истории, append-only events и admin-only live MFA/session/role recheck. Миграция 030 добавляет три least-privilege таблицы; OpenAPI 0.0.61 расширен тремя согласованными endpoint-ами, manual test docs и regression coverage синхронизированы.

0.0.148 - 10.29.2026 | 16:03 - Подготовлены канонические meal/admin origins: TLS-edge шаблон, временные 302 rollback aliases, public-origin verification и точный cutover/rollback runbook.

0.0.147 - 10.29.2026 | 15:37 - Observability checkpoint закрыт после полной VPS-приёмки: hardened systemd collector/timer, exact file metadata, atomic и Docker-degraded partial сценарии, compose mount/socket verification, real admin+MFA snapshot и четыре темы админки подтверждены. Admin 0.0.124 прошёл CI/image/deploy runs 40857924493/40858092836; tracker и runbook синхронизированы без изменения API, БД или runtime backend.

0.0.146 - 10.29.2026 | 15:01 - VPS bootstrap drill выявил отсутствие `/etc/sysusers.d` на чистом Ubuntu 24.04 до изменения Compose. Runbook теперь явно создаёт root-owned системные каталоги sysusers/tmpfiles вместе с libexec до установки artifacts; regression test фиксирует порядок. Удалён неработающий для `Type=oneshot` `RuntimeMaxSec`; bounded runtime остаётся на `TimeoutStartSec=30`. Приложение и БД при неуспешной попытке не затрагивались.

0.0.145 - 10.29.2026 | 14:41 - Усилен observability deployment/security gate: reader требует exact root:29002 metadata 2750/0640 для parent/file и ограничивает возраст старых snapshots; verify проверяет единственный backend RO mount, отсутствие observability/docker socket у остальных containers и прогоняет строгий reader. Host bootstrap обязателен до rollout, проверяет staged candidate checksums и сохраняет checksummed root-artifact backup; disabled mode сохраняет безопасный mount. Collector без systemd-зависимости от Docker успешно публикует fresh partial snapshot при ожидаемой Docker-деградации. Endpoint ограничен 12 запросами/мин, aggregate transaction — statement timeout 2s. Runtime checkpoint остаётся in-progress до VPS smoke; DB schema/grants и response payload не менялись.

0.0.144 - 10.29.2026 | 14:16 - Добавлен admin-only observability endpoint с live MFA/role/session recheck и audit, bounded host/DB/queue/worker/provider snapshot, строгими freshness/no-samples/stale/unavailable semantics и без identifiers/raw errors. Host/container данные собирает отдельный root-owned hardened systemd collector в atomic sanitized JSON; backend получает только read-only directory mount без Docker socket. Добавлены fail-closed config/disable/rollback runbook и regression/static tests; HTTP API расширен только согласованным GET, DB schema/grants не менялись.

0.0.143 - 10.29.2026 | 14:02 - Исправлена runtime-проверка нового worker container: deploy verification теперь ограниченно ждёт Docker health до 90 секунд и не считает штатный `start_period` ошибкой. Добавлен regression-контракт bounded wait; HTTP/API/DB schema/URL/payload не менялись.

0.0.142 - 10.29.2026 | 13:28 - Добавлен отдельный production worker/scheduler на том же immutable backend image: пустой fail-closed allowlist из пяти безопасных задач, global concurrency 1, PostgreSQL lease/fencing, bounded timeout с TERM/KILL, jitter/backoff и poison isolation, graceful shutdown и low-cardinality health evidence. Первый запуск отложен на полный interval, повторное планирование считается от completion time без catch-up, `skipped_overlap` сохраняет failure history, а DB pool первого cutover ограничен двумя соединениями. Worker использует минимальный DI-модуль без HTTP-auth/MFA/provider secrets, hardened container без ingress, а production compose явно отключает embedded loops; destructive retention требует отдельного versioned approval. Обновлены deploy/verify/runbook и regression-тесты restart/overlap/lease-loss/timeout/poison/config/compose без изменения HTTP/API/DB schema/URL/payload.

0.0.141 - 10.29.2026 | 12:43 - Уточнена внутренняя архитектура без изменения HTTP/API/DB/URL: operational readiness теперь тестируемо отражает готовые schema-v29 lease и telemetry capabilities; добавлен CI-gate направлений зависимостей и циклов; AppConfig contract перенесён в shared; единая WorkerRuntimeFactory устранила три concrete-сборки; разорваны четыре междоменных SCC через нейтральные account/workflow/scope/recipe primitives; reputation и achievements выделены из content-release orchestration за совместимым facade.

0.0.140 - 10.29.2026 | 12:06 - Синхронизированы 11 пользовательских legal draft-текстов с согласованной заглушкой `[Тут будут данные]` при сохранении `draft_blocked`/`publicationEligible:false`; добавлен regression-test, исключающий случайную публикацию. Зафиксирован последовательный бесплатный production tracker и точный owner-input checklist для observability, email, storage/scanner, OCR, push, backup и будущего AI; API, схема БД и consent evidence не менялись.

0.0.139 - 10.29.2026 | 11:23 - Актуализированы live Docker inventory и единый production TODO по данным read-only legacy root и текущего operational-readiness: отдельно отмечен закрытый Docker/schema v29 cutover тестового стенда и зафиксирован последовательный план внешних gates — legal/data processing, off-host backup/observability, email, storage/scanner, OCR, payments/receipts/refunds, push, AI, workers/shared lease и финальная физическая приёмка. Provider credentials и публичные контракты не добавлялись.

0.0.138 - 10.29.2026 | 11:12 - Post-deploy verify адаптирован к Docker 29.9: служебное значение `invalid IP` у internal network больше не превращается в ложный trusted proxy gateway. Gate принимает только валидные IPv4, а production smoke зафиксировал единственный фактический Nginx source `172.31.0.1/32`; широкие сети и internal DB gateway не доверяются.

0.0.137 - 10.29.2026 | 11:05 - Production readiness подтвердил, что точечные table grants не работают без schema traversal: `application-grants.sql` теперь явно выдаёт `meal_app` только `USAGE` на schema `meal`, сохраняя `CREATE=false`. Это синхронизирует фактические grants с ранее документированным least-privilege контрактом и позволяет readiness использовать разрешённую `schema_migrations`; публичные DTO и endpoint-ы не менялись.

0.0.136 - 10.29.2026 | 10:17 - В deployment runbook добавлена краткая карта для человека и агента: `main`/GHCR digest, allowlisted helper, server paths, ports, health, first restore и rollback boundary. Добавлен `meal-planner-compose.service`, который после reboot идемпотентно поднимает текущие digests без автомиграций. Первый production cutover устранил fail-closed проблемы restore/secrets и readiness: bootstrap корректно читает root-only dump и подключает `pg_restore` ролью `meal_owner`, backend/migrate получают отдельный supplemental GID `29001`, а Pool сохраняет URI option `-c role=meal_app` при добавлении timezone/search_path; секреты не добавлялись.

0.0.135 - 10.29.2026 | 10:13 - В repository deployment contract добавлен точный host-Nginx template для TLS edge: public origin проксирует API/health/frontend на loopback `3001/3000`, admin origin — API/backend и SPA container на `3002`; сертификаты, security headers и firewall boundary сохранены.

0.0.134 - 10.29.2026 | 10:06 - Compose observation commands в production runbook синхронизированы с фактическим deployment layout: helper-файлы лежат в `/srv/meal/deployment`, non-secret settings читаются из `/etc/meal-planner/deploy.env`, а текущие digests — из root-owned `images.env`; runtime/API не изменялись.

0.0.133 - 10.29.2026 | 09:47 - Docker build context включает `contracts/http-cases.json`, который нужен TypeScript-сборке contract-теста; исправлен Linux-only container build failure без изменения runtime/API.

0.0.132 - 10.28.2026 | 17:51 - Добавлена production Docker/Compose и GitHub Actions инфраструктура общего стека с immutable digest images, явными migration/backup/verify/rollback gates и hardening; Docker secrets поддержаны через безопасные `_FILE` переменные. Recovery contract синхронизирован со schema v29 / 483 FK, runtime-role документирован как `meal_runtime` login с effective `role=meal_app`, а runbook переведён с legacy systemd/symlink smoke на фактический Compose health/rollback/observation и фиксирует текущий legacy health-route blocker.

0.0.131 - 28.10.2026 | 13:12 - Docs-only repository revision синхронизирует live admin `0.0.117` и immutable release `20261028-0757`: root/deep-link отвечают `200`, password → mandatory MFA и `coffee-light` / `nature-dark` smoke прошли без runtime errors. Deployed backend остаётся `0.0.128` / schema v29; runtime-код и публичные контракты не менялись.

0.0.130 - 28.10.2026 | 12:38 - Docs-only repository revision синхронизирует live frontend root/app `0.0.28`/`0.0.137` и immutable release после исправления независимого запуска online session при недоступном offline Service Worker. Зафиксирован read-only desktop/mobile acceptance 24/24 без mutation requests и runtime errors; deployed backend остаётся `0.0.128`, runtime-код и публичные контракты не менялись.

0.0.129 - 28.10.2026 | 12:25 - Docs-only repository revision фиксирует фактический rollout backend 0.0.128, clients-first порядок, schema v29/checksum, свежий pre-migration backup, health/invariant smoke и runtime APP_VERSION; исполняемый release и публичные контракты не менялись.

0.0.128 - 28.10.2026 | 11:35 - Все admin recipe moderation mutations закрыты server-side critical-confirmation gate до idempotency replay; fresh-PG acceptance проверяет missing/stale unlock proof, отсутствующее/истёкшее critical window и успешный valid replay.

0.0.127 - 28.10.2026 | 11:05 - Admin content получил независимые revision-aware оси review/publication с безопасным publicReason; добавлены contract/unit и fresh-PostgreSQL endpoint-проверки сценария active r1 + rejected r2.

0.0.126 - 28.10.2026 | 10:44 - Добавлен отдельный fresh-PostgreSQL acceptance для revision-aware recipe lifecycle: reject с сохранением старой публикации, replacement, оси review/publication, stale/downgrade/concurrent publish, безопасный publicReason, rollback с active-sibling guard, critical global hide и archive/restore без републикации.

0.0.125 - 28.10.2026 | 23:10 - Recipe moderation переведена на revision-aware lifecycle: moderator approve→publish, admin approve сразу публикует, replace/ reject/hide/unpublish/archive/critical-report сохраняют единый publication/case/reputation инвариант. Migration 029 добавляет recipe_id, compatibility backfill/trigger, composite FK и уникальность active publication/case; workspace DTO получает безопасные review/publication без внутренних заметок. Добавлены fresh и v28→v29 PostgreSQL acceptance, rollback несовместимых дублей, OpenAPI/docs/testing baseline v29.

0.0.124 - 27.10.2026 | 18:41 - Deployment/runbook приведён к фактическому тестовому стенду: зафиксированы immutable releases, canonical live/ready endpoints, schema v28, UFW, swap и проверенная chain runtime-ролей; добавлены воспроизводимые build/deploy/smoke/rollback/cleanup шаги без секретов. Удалены невыполнимые после разделения репозиториев команды production-readiness; runtime API, схема и данные не менялись.

0.0.123 - 27.10.2026 | 17:45 - Account-deletion revoked-role acceptance переиспользует отдельного резервного test-admin из content-domain fixture и выполняет revoke/restore/cleanup только в SERIALIZABLE транзакциях. Проверка соблюдает DB write-policy и инвариант последнего администратора; runtime API и схема не менялись.

0.0.122 - 27.10.2026 | 17:35 - Fresh PostgreSQL 18 acceptance исправляет тип контрольной выборки account-deletion review: UUID request id явно приводится к text перед сравнением с idempotency_records.target_binding. Endpoint/runtime API, схема и данные не изменились.

0.0.121 - 27.10.2026 | 17:24 - Fresh PostgreSQL 18 acceptance изолирует конкурентный account-deletion review/replay/conflict на отдельном тестовом remote address, чтобы общий Fastify rate-limit не маскировал ожидаемый idempotency conflict ответом 429. Runtime API, лимиты и схема не изменились.

0.0.120 - 27.10.2026 | 17:13 - Fresh PostgreSQL 18 acceptance учитывает уникальность staff-role на пользователя: временная резервная admin-role назначается отдельному test-user, а не действующему moderator. После проверки роль отзывается; runtime API и схема не изменились.

0.0.119 - 27.10.2026 | 17:04 - Fresh PostgreSQL 18 acceptance revocation-case теперь временно назначает резервного администратора и после восстановления основной роли отзывает его: проверка fresh admin-role больше не нарушает production-инвариант запрета удаления последнего активного администратора. Runtime API и схема не изменились.

0.0.118 - 27.10.2026 | 16:53 - Fresh PostgreSQL 18 acceptance выявил и закрыл least-privilege дефект content-workflow: роль meal_app теперь может читать только необходимое поле catalog_merges.preview для проверки version-bound not-duplicate решения. Добавлен source-regression; wire API, схема и миграции не изменились.

0.0.117 - 27.10.2026 | 16:29 - Catalog content-workflow закрывает stale merge и authorization TOCTOU без изменения wire API: обе карточки блокируются в стабильном порядке и повторно сверяются внутри serializable effect-транзакции, previewKey пересчитывается по актуальным данным, updates связаны с версиями, route target обязан входить в пару, а admin-role проверяется до replay/effect. Решение not-duplicate блокирует точную неупорядоченную пару версий до значимого изменения; acceptance покрывает stale/path/revoked-role/concurrent replay и единственность effect/audit/idempotency.

0.0.116 - 27.10.2026 | 15:49 - Для административного review удаления аккаунта добавлен обязательный UUID idempotencyKey и транзакционный actor-bound replay через meal.idempotency_records. Точный, в том числе конкурентный, повтор возвращает сохранённую deletion projection строго целевого request без второго review-step/audit даже при наличии более нового запроса пользователя; повтор ключа с другим payload отвечает 409. До replay/effect транзакционно перепроверяется актуальная admin-role, закрывая revoke TOCTOU. Повтор пользовательского deletion request при существующем `blocked` возвращает его projection без конфликтующей вставки. Сохранён осознанный повтор review с новым ключом и актуальной версией; OpenAPI и PostgreSQL acceptance обновлены.

0.0.115 - 27.10.2026 | 11:05 - Развёрнут тестовый production-стенд с systemd/Nginx/TLS/firewall, loopback API/PostgreSQL и отдельными frontend/admin origins; добавлен эксплуатационный runbook. Исправлена диагностика HTTP 500: серверный журнал теперь сохраняет безопасные технические поля исключения, не раскрывая их клиенту. Smoke подтвердил frontend login, admin password+MFA, dashboard и health; runtime роли БД задан `search_path=meal,public`.

0.0.114 - 26.10.2026 | 15:05 - Production-приёмка: PostgreSQL 18.6 acceptance исправлен для корректной последовательности доменов, разрешённого временного root и идемпотентного переиспользования обязательных единиц `pcs`/`g` на уже инициализированной базе; WAN/SSH-диагностика отделена от обязательных локальных latency/burst/heap gates; добавлены подробные руководства ручной проверки БД и backend/API, включая SQL/heap/pool/resource soak.

0.0.113 - 24.10.2026 | 19:29 - Инструкции запуска обновлены для трёх независимых проектов meal_backend, meal_frontend и meal_admin; сохранены API, origins и существующая baseline БД.

0.0.112 - 24.10.2026 | 19:16 - Добавлены только канонические справочники: 7 единиц измерения и 3 тарифных продукта, без demoaccounts и подписок. Явное транзакционное применение с проверкой конфликтов; повторное применение сохраняет IDs.

0.0.111 - 24.10.2026 | 18:20 - Backend выделен в самостоятельный репозиторий: локальные миграции, контракты, документация и команды проверки без зависимости на общий корень. Исправлены устаревшие SHA256 migration manifest для неизменённых SQL 003/006/007/008/010. Обновлены zod/Fastify/Nest и совместимые transitives: npm audit без уязвимостей. Тестовая PostgreSQL18 развёрнута, проверены grants, транзакционный rollback и восстановление backup в отдельную БД.

0.0.106 - 14.10.2026 | 15:21 - Account/account-lifecycle exact coverage повышено до 137 операций; добавлена migration 027, server-side export_not_ready, persisted blocked/audit и успешная delete-финализация после ready export и повторного review.

0.0.105 - 14.10.2026 | 16:20 - Admin operations inspect/preview/execute получили exact jobs/incidents lifecycle, replay/stale/concurrency и DB/audit assertions; route/body action mismatch теперь отклоняется до любого эффекта.

0.0.104 - 14.10.2026 | 15:30 - Admin billing view/command получили exact Plus/Pro gift lifecycle: critical gate, replay/conflict/stale, concurrency, entitlement/DB/audit readback и compensation AI на Pro; исправлены FOR UPDATE read-only каталога и append-only истории.

0.0.103 - 14.10.2026 | 14:53 - Exact live-PG acceptance добавлен для community feed/comments: фильтры, публичная проекция, cursor pagination, removed/missing/invalid states. Cursor сравнивает ту же миллисекундную точность, которую отдаёт Node, без повторов между страницами.

0.0.102 - 14.10.2026 | 14:00 - Exact live-PG acceptance добавлен для 8 finance и 3 pricing операций; исправлен 500 в update expense из-за неоднозначного SQL version, проверены replay/stale/readback и former-Pro read-only.

0.0.101 - 14.10.2026 | 13:00 - Все 8 support endpoints получили operation-specific live-PG lifecycle: meta/list/create/detail/edit/reply/close/reopen, owner isolation, fail-closed attachments, replay/conflict и exact DB effects; классификация 94 exact / 245 pending.

0.0.100 - 14.10.2026 | 12:45 - Products, recipes/bookmarks и unified search получили operation-specific live-PG success/effect/readback acceptance; классификация 86 exact / 253 pending, stores доступны application-role только на чтение.

0.0.99 - 14.10.2026 | 12:00 - Moderator decision API теперь отклоняет несовместимые со статусом действия, detail не предлагает actions без назначения текущему модератору; добавлен regression-набор таблицы переходов.

0.0.98 - 14.10.2026 | 11:05 - Live-PostgreSQL exact coverage дополнен user sessions/revoke-others, legal consent state/history, privacy state/update, own/update/public profile и front/admin telemetry с DB/readback/audit/isolation assertions. Добавлены минимальные profile-write grants, structured supplemental evidence и симметричная forced-GC heap-метрика; классификация 77 exact / 262 pending.

0.0.97 - 14.10.2026 | 07:58 - Exact live-PostgreSQL coverage расширен с 52 до 66 операций: закрыты admin/staff TOTP/recovery auth, Free-AI grant/view и notification preferences/list/read/read-all. Исправлены Free-AI response projection, notification UPDATE grant и strict notification response; backend 273/273 и fresh-PG smoke проходят.

0.0.95 - 14.10.2026 | 05:46 - PostgreSQL acceptance-runner теперь сохраняет `results.json` через локальный Prettier и немедленно проверяет его exit code, поэтому versioned I1/I2/I3 evidence входит в штатный backend lint; три свежие итерации повторены на этой версии.

0.0.94 - 14.10.2026 | 05:37 - Зафиксированы три свежие PG18.6 acceptance-итерации в versioned JSON/log evidence; Inventory 8/8 operationId подтверждены success/readback/replay/stale rollback/effects, классификация 347 операций проходит в общем наборе 273/273.

0.0.93 - 14.10.2026 | 06:10 - InventoryController получил operation-specific live-PostgreSQL acceptance всех 8 operationId и command/location веток с readback, replay, stale/rollback и DB effects; добавлены полная классификация 347 операций и сохраняемые I1/I2/I3 evidence-пакеты.

0.0.92 - 14.10.2026 | 05:24 - Актуальный PostgreSQL acceptance report синхронизирован со схемой v26: миграции 001–026, 209 таблиц/482 FK, тарифные/consent/moderator границы, 347-operation defensive sweep и 10,000-row performance/lock baseline.

0.0.91 - 14.10.2026 | 01:01 - Fresh-PG acceptance теперь в каждой итерации создаёт 10,000 связанных inventory batches, измеряет list/search p50/p95/p99, сохраняет `EXPLAIN ANALYZE` list/search/count и проверяет lock timeout `55P03` с точным retry recovery. Три чистые итерации PASS.

0.0.90 - 14.10.2026 | 00:18 - Moderator reject теперь сохраняет terminal status `rejected`, поэтому отклонённый case не остаётся активным в queue/SLA; fresh-PG acceptance расширен конкурентным claim двух модераторов и всеми decision actions.

0.0.89 - 13.10.2026 | 23:07 - Fresh-PG acceptance получил локальные performance guardrails: p50/p95/p99 health/entitlement/former-Pro/admin, 40-request pool burst, bounded heap growth и deterministic global rate-limit 429 на запросе 201. Три итоговые итерации PASS.

0.0.88 - 13.10.2026 | 22:55 - Fresh-PG moderator acceptance расширен реальными moderation cases: stale-version, claim/exact replay, changed replay, approve/exact replay, skip и точные claims/decisions/idempotency/audit/release effects. Owner-соединение ограничено подготовкой billing/media fixtures; приложение работает только под meal_app. Три итерации PASS.

0.0.87 - 13.10.2026 | 22:43 - Live moderator acceptance получил stateful support ticket: detail, reply, exact idempotent replay без дубля, changed replay 409, reopen и точные counts для messages/events/idempotency/audit. Три fresh-PG итерации повторены успешно.

0.0.86 - 13.10.2026 | 22:14 - Fresh-PG acceptance расширен реальными Free→Plus trial→Pro→former-Pro переходами, family active/blocked, special-category revoke/regrant, шестью moderator queues с отзывом grant/role, 22 admin reads с session/unlock, 213 role-aware mutations и раздельными logout. Три финальные итерации PASS, временные runtime удалены.

0.0.85 - 13.10.2026 | 21:33 - HTTP gate расширен до 1 269 defensive-запросов; self-cleaning runner трижды проверяет fresh PG18, 132 authenticated GET и 214 mutation boundaries. Устранены четыре DB-only 500 и недокументированный multipart 406, нормализованный в 415; добавлен regression-test.

0.0.84 - 13.10.2026 | 20:55 - Добавлен исполняемый HTTP coverage-gate для всех 347 OpenAPI operations: live Fastify registration, безопасный unauthenticated request, только документированные статусы, строгий error envelope, обязательные request ID/no-store и запрет 500/501.

0.0.83 - 13.10.2026 | 15:03 - Acceptance runtime в штатном back/.local исключён из ESLint и Prettier, чтобы live PostgreSQL из runbook не ломал проверки исходного кода.

0.0.80 - 12.10.2026 | 18:34 - Legal gate требует независимые approval references и умеет offline-проверять будущий evidence-файл против текущего release tuple; account deletion теперь отзывает password/tokens/MFA/critical/staff access. OpenAPI 0.0.59 без изменений.

0.0.79 - 12.10.2026 | 17:28 - OpenAPI 0.0.59: first-party telemetry пишет безопасные browser/backend/provider/worker события в админку; workers получили PostgreSQL lease/fencing, schema v24 (205/476), backup contract v3 и readiness scaffolds без применения БД.

0.0.78 - 10.12.2026 | 16:19 - PostgreSQL 18 clean-bootstrap исправлен и трижды подтверждён на live DB: атомарные migrations 001–023, 204 таблицы/476 FK, ограниченная meal_app, v22 grants, readiness v23, recovery evidence v2 и реальный account lifecycle; OpenAPI 0.0.58 без изменений.

0.0.77 - 10.09.2026 | 15:29 - OpenAPI 0.0.58 без изменений: strict legal release evidence, approval/surface/consent binding и offline fail-closed gate.

0.0.76 - 10.09.2026 | 15:11 - OpenAPI 0.0.58 без изменений: worker lease/run health, backup/restore evidence, read-only production acceptance и offline readiness gates.

0.0.75 - 10.09.2026 | 14:58 - OpenAPI 0.0.58 без изменений: versioned nine-task worker topology, bounded one-shot planner и read-only deployment manifest.

0.0.74 - 10.09.2026 | 13:54 - OpenAPI 0.0.58 без изменений: provider-neutral secret references/material, strict provider telemetry и observer с fail-safe delivery.

0.0.73 - 10.09.2026 | 13:45 - OpenAPI 0.0.58 без изменений: provider-neutral durable OCR port, ready/clean/encrypted gate, provider/mode/source/checksum binding, versioned external consent и mandatory review.

0.0.72 - 10.09.2026 | 13:35 - OpenAPI 0.0.58 без изменений: provider-neutral email/Web Push ports, delivery state/binding/webhook policies, quiet-hours/consent gate и два registered fail-closed providers.

0.0.71 - 10.09.2026 | 13:09 - OpenAPI 0.0.58 без изменений: provider-neutral storage/KMS/scanner ports, quarantine lifecycle, binding/TTL policies и три зарегистрированных fail-closed provider-а; PostgreSQL не менялась.

0.0.70 - 10.09.2026 | 12:59 - OpenAPI 0.0.58 без изменений: provider-neutral payment port, state/binding/webhook policies и зарегистрированный disabled provider; provider/merchant остаются real-data TODO.

0.0.69 - 10.09.2026 | 12:46 - OpenAPI 0.0.58 без изменений: `AiProvider` переведён на OpenAI Responses API, reasoning low, `store=false`, строгий `output_text` parsing и fail-closed provider errors.

0.0.68 - 10.09.2026 | 12:25 - OpenAPI 0.0.58: preview/commit для платного lifecycle Plus/Pro, пропорциональный upgrade, renewal, downgrade, promo и Combine; PostgreSQL/grants не применялись.

0.0.67 - 10.09.2026 | 11:42 - OpenAPI 0.0.57: Pro export domains/formats, versioned manifest, entitlement cutoff, ACL recheck на enqueue/worker/download и former-Pro history.

0.0.66 - 10.09.2026 | 10:58 - OpenAPI 0.0.56: `ai-task-policy-v2`, immutable context/priority/budget preview, 18 задач и подготовленная migration 023 без применения PostgreSQL.

0.0.65 - 10.08.2026 | 18:45 - OpenAPI 0.0.55: Pro deterministic plan optimization, explicit priority order, candidate assessments, honest coverage и stale-safe commit.

0.0.64 - 10.08.2026 | 18:20 - OpenAPI 0.0.54: `view=calendar` проецирует выбранный месяц и требует отдельную Pro calendar capability.

0.0.63 - 10.08.2026 | 18:05 - OpenAPI 0.0.53: private financial analytics по периоду/категории, receipt/store metrics, savings coverage и nullable forecast при недостаточной истории.

0.0.62 - 10.08.2026 | 17:07 - OpenAPI 0.0.52: Pro electronic receipts, exact financial lines, fiscal metadata, active-Pro gate и receipt-linked private expenses/price observations; PDF/OCR fail closed, PostgreSQL не применялась.

0.0.61 - 10.08.2026 | 16:38 - OpenAPI 0.0.51: private price observations с consent/provenance, read-only system medians и approximate recipe/list/plan estimates с honest incomplete totals; grants подготовлены, PostgreSQL не применялась.

0.0.60 - 10.08.2026 | 15:42 - OpenAPI 0.0.50: private manual finance expenses и overall budgets с RUB minor units, explicit consent, idempotency, optimistic versions, audit и former-Pro read-only; grants подготовлены, PostgreSQL не применялась.

0.0.59 - 10.08.2026 | 11:25 - OpenAPI 0.0.49: nutrition settings/profile/targets/analytics, append-only target periods, honest-null completeness/progress, optimistic concurrency/idempotency/audit и former-Pro cutoff без миграций.

0.0.58 - 10.08.2026 | 10:24 - OpenAPI 0.0.48: portion proposal→private diary sync, manual/24h timeout, former-Pro late cancel, CAS/audit/runner и fail-closed media boundary без миграций.

0.0.57 - 10.07.2026 | 20:13 - Private diary day/sources/create/update/archive, immutable snapshots, atomic personal inventory debit, idempotency, audit, optimistic versions and reusable Pro access boundary; OpenAPI 0.0.47.

0.0.56 - 07.10.2026 | 19:21 - OpenAPI 0.0.46: добавлен `GET /api/v1/pro/overview` с активным и former-Pro read-only доступом, фактическими целями/счётчиками/AI-квотами и запретом выдуманных значений; PostgreSQL не изменялась.

0.0.55 - 07.10.2026 | 18:29 - Исправлены статистика готовки, полный total поддержки, sanction-before-replay, авторизация content releases, TOCTOU rollback, worker claimed count и подсчёт публикаций; подготовлены migration 022 и runner будущей передачи семейной Plus.

0.0.54 - 06.10.2026 | 14:20 - Явный registry доменных compensator-ов: content release, moderation, sanction и recipe-policy; critical/CAS/preview/idempotency/audit, неизвестные операции fail closed.

0.0.53 - 06.10.2026 | 14:03 - PostgreSQL admin billing для Plus grant/extend/revoke/freeze/unfreeze и legal/compensation review read+preview; refund/export/generic rollback fail closed.

0.0.52 - 06.10.2026 | 13:41 - Исправлены blocker-запросы удаления аккаунта на `subscriptions.owner_id` и `billing_orders.payer_id/recipient_id`; контракт не менялся.

0.0.51 - 06.10.2026 | 13:20 - Отдельный moderator API с MFA/role/grant проверками, claim/skip, решениями и безопасной поддержкой; OpenAPI 0.0.45.

## 0.0.50 — 6 октября 2026

OpenAPI 0.0.44: content-release registry расширен строго типизированными `content_document` и `dictionary_entry`. Оба адаптера поддерживают create/update/retire, validation, canonical heads, атомарные publish/rollback и edit-from-current; sources API возвращает их проекции. Неизвестные namespace/dictionary/schemaVersion fail closed, realtime moderation/allergen mappings/news не менялись. Подготовлена migration 021/readiness v21 (203 таблицы/474 FK), PostgreSQL не применялась.

## 0.0.49 — 6 октября 2026

OpenAPI остаётся 0.0.43: новых HTTP-операций нет. In-app новости можно безопасно планировать; bounded runner
публикует наступившие записи под `SKIP LOCKED` и создаёт уведомления с устойчивым dedup key. Истёкший ignore
инцидентов теперь сохраняемо возвращается в `new` с системным аудитом. Retention entrypoint-ы для ошибок, метрик и
file metadata работают только как policy-aware dry run и ничего не удаляют. Регистрация получила отключённую по
умолчанию provider-neutral risk/CAPTCHA/disposable-email policy с явными fail-open/fail-closed режимами. Порог
публикации статистики готовки вынесен в versioned rule `cooking_statistics_publication`, builtin v1 = 3. Новых
миграций нет; PostgreSQL, внешние провайдеры и scheduler не подключались.

## 0.0.48 — 6 октября 2026

OpenAPI 0.0.43: manifest-based личный/семейный экспорт с server ACL snapshot, одноразовый user critical reauth, архивирование и request/cancel/admin approve/reject/finalize жизненного цикла удаления. Export и retention runners доступны только как ручные entry points; storage, scheduler и policy values не подключены и fail-closed. PIN trust по умолчанию 30 дней. Подготовлена migration 020/readiness v20 (203 таблицы/474 FK), PostgreSQL не применялась.

## 0.0.47 — 6 октября 2026

Добавлен aggregate evaluator всех 60 согласованных достижений с идемпотентной выдачей по стабильному коду и lazy backfill исторических данных. Admin moderation получил канонический transition содержательной catalog correction: принятие начисляет +2 репутации, отмена создаёт точный append-only reversal, повторные переходы сохраняют auditable compensation chain. Публичный OpenAPI остаётся 0.0.42; migration 019/checksum обновлены, PostgreSQL не применялась, тесты не запускались.

## 0.0.46 — 6 октября 2026

Добавлены публичные достижения и числовая репутация с 10 release-managed званиями. Контент-релизы хранят серверный draft, typed patches, version/idempotency и точный client checksum ack; publish/rollback атомарны, требуют critical reauth и сохраняют immutable snapshots. Rollback возвращает релиз в draft, edit-from-current создаёт новую ревизию из актуальных canonical heads. Подготовлена migration 019/readiness v19 (201 таблица/470 FK); PostgreSQL не изменялась. OpenAPI 0.0.42; tests/browser QA не запускались.

## 0.0.45 — 6 октября 2026

Добавлены публичные community/news/search read-модели, подписки на авторов, приватность AI, история/архив AI, формальные AI-апелляции, безопасные preview экспорта, деталь жалобы и добровольная передача владения семьёй без срока. Admin news получил versioned draft/preview/in-app publish/cancel/test и аудит чтения; email/push/scheduler/export generation fail-closed. Подготовлена migration 018 и readiness v18 (194 таблицы/457 FK), PostgreSQL не изменялась. OpenAPI 0.0.41; tests/browser QA не запускались.

## 0.0.44 — 5 октября 2026

Добавлен отдельный allergen intelligence: универсальные versioned mappings ingredient/variant/SKU, typed admin subject selector, recipe projection с icon/evidence/unknown groups, пользовательский report-to-support и admin lifecycle mappings/fallback icons. Upload честно недоступен до storage/scanner. Migrations 016/017 зарегистрированы в manifest/readiness v17 (192 таблицы/452 FK), grants подготовлены, PostgreSQL не изменялась. OpenAPI 0.0.40; tests/browser QA не запускались.

## 0.0.43 — 5 октября 2026

Рекомендации вынесены в отдельный `recommendations` module: типизированные recipe/author candidates, детерминированный `personalized-v1`, reasons/safety warnings, diversity, collaborative thresholds, события выдачи и desired-state follow/unfollow. Подготовлены migration 016 и least-privilege grants, но PostgreSQL не изменялась. OpenAPI 0.0.38; tests/browser QA не запускались по действующему решению.

## 0.0.42 — 5 октября 2026

Добавлено пользовательское управление подпиской: read model текущего тарифа и AI-балансов, одноразовый 7-дневный Pro trial с 10 AI-действиями, simulation preview/commit для Plus на месяц или год и запланированное понижение в Free после оплаченного периода. Команды защищены версиями, идемпотентностью и транзакционным аудитом; подготовленные application grants дополнены для новых таблиц и `users.version`. OpenAPI 0.0.37; PostgreSQL и миграции не изменялись, реальные списания отсутствуют, тесты по действующему решению не запускались.

## 0.0.41 — 5 октября 2026

Версия синхронизирована с frontend-итерацией семейной области по умолчанию. Backend-контракты и OpenAPI 0.0.36 не менялись; PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-family-scope-iteration.md.

## 0.0.40 — 5 октября 2026

Preview и подтверждение вступления/выхода из семьи перераспределяют только свободный остаток семейной подписочной AI-квоты; исключение участника использует тот же транзакционный расчёт. Потраченные, зарезервированные и переданные действия не отзываются, изменения аудируются в `ai_ledger`. OpenAPI 0.0.36. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-redistribution-iteration.md.

## 0.0.39 — 5 октября 2026

Добавлена подтверждаемая донором передача AI-действий между участниками семьи после исчерпания доли: идемпотентность, version guard, ledger-аудит и срок до конца периода. OpenAPI 0.0.35. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-transfer-iteration.md.

## 0.0.38 — 5 октября 2026

Семейный AI-резерв Plus включён в баланс действующего участника, но расходуется только после отдельного подтверждения конкретного запуска или нового платного интервала. Согласие аудируется в `ai_reserve_consents`; OpenAPI 0.0.34. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-reserve-iteration.md.

## 0.0.37 — 1 октября 2026

Завершён согласованный Plus-срез: полный lifecycle семейных приглашений, семейные заготовки и QR, базовый подбор рецептов по личным/семейным запасам, месячные AI-квоты и административное управление семьями и передачей Plus при бане. OpenAPI 0.0.33; migration v15 и grants только подготовлены, SQL не применялся. Объединение Plus в Pro остаётся этапом Pro.

## 0.0.36 — 1 октября 2026

Умные списки и длинные горизонты планирования ограничены Plus/Pro. Добавлены preview/commit еженедельного повторения выбранного рецепта, расчёт реальных 52/53 дат, пропуск занятых слотов без перезаписи и сохранение правила в `plan_rules`. OpenAPI 0.0.32; схема остаётся v14, SQL не применялся.

## 0.0.35 — 1 октября 2026

Добавлены версионируемые QR-этикетки личных заготовок для Plus/Pro: entitlement, идемпотентный выпуск, отзыв прежней версии, безопасный offline payload, аудит и подготовленный grant. OpenAPI 0.0.31; схема остаётся v14, SQL не применялся.

## 0.0.34 — 1 октября 2026

Добавлен семейный чат: доступ с даты вступления, поиск, replies, активные mentions, авторские edit/tombstone, личное скрытие, реакции, закрепления, черновик и read receipt. OpenAPI 0.0.30. Подготовлена migration 014 и схема v14; SQL не применялся.

## 0.0.33 — 1 октября 2026

Добавлены семейные текстовые заметки и чек-листы: авторские изменения, совместные отметки, архив, immutable-ревизии, аудит, optimistic concurrency и идемпотентность. OpenAPI 0.0.29; схема v13 не менялась, application grants только подготовлены, SQL не применялся.

## 0.0.32 — 1 октября 2026

Семейный план поддерживает диапазон до 366 дней и распределение порций по активным участникам. Добавлены назначение prepared-еды, немедленное списание, 24-часовое автоподтверждение и отмена без возврата остатка. OpenAPI 0.0.28; схема v13 не менялась, SQL не применялся.

## 0.0.31 — 1 октября 2026

Shopping, receipt и purchase workflows поддерживают private/family scope, повторную проверку семейного доступа, scope-bound идемпотентность и аудит действий списка. OpenAPI 0.0.27; схема v13 уже содержит нужные связи, SQL не применялся. Backend-набор — 132/132.

## 0.0.30 — 1 октября 2026

Recipe workspace поддерживает private/family scope, семейное чтение при действующем покрытии и авторские mutations без передачи владения рецептом. OpenAPI 0.0.26; схема остаётся v13, SQL не применялся. Backend-набор — 132/132.

## 0.0.29 — 1 октября 2026

Inventory API поддерживает строго разделённые private/family scope с повторной проверкой членства и покрытия, общими семейными партиями, местами и историей. OpenAPI 0.0.25; схема остаётся v13, SQL не применялся.

## 0.0.28 — 1 октября 2026

Вторая итерация Plus: выход и исключение участника, обязательная ручная/автоматическая передача владения, архивная история членства и полноэкранное уведомление преемника. OpenAPI 0.0.24; схема v13 не менялась, application grants только подготовлены. PostgreSQL не изменялась; 130 тестов.

## 0.0.27 — 1 октября 2026

Первая итерация Plus: единый entitlement service, `GET /entitlements`, семейный context/create API, строгие DTO, аудит, идемпотентность и защита конкурентного создания. OpenAPI 0.0.23; схема остаётся подготовленной v13, добавлены только application grants. PostgreSQL не изменялась и миграции не применялись.

## 0.0.26 — 1 октября 2026

OpenAPI 0.0.22: Free-admin workspace санкций/прав, текстовой поддержки, модерации/каталога и безопасных операций переведены с 503-заглушек на PostgreSQL-адаптеры. Подготовлена, но не применена migration 013 для обязательной категории санкции и приватной staff-заметки; целевая схема v13 остаётся 186 таблиц/436 FK. Вложения поддержки fail closed до object storage и медиасканера; произвольные и финансовые background jobs не запускаются.

## 0.0.25 — 1 октября 2026

OpenAPI 0.0.21: добавлены реальные admin-endpoint’ы просмотра и критичной идемпотентной выдачи Free AI-квоты, а также PostgreSQL-адаптер центра admin-уведомлений. Подготовлена, но не применена миграция 012 для настроек уведомлений и lifecycle инцидентов; целевая схема v12 — 186 таблиц/436 FK. Карточка пользователя больше не смешивает Free-операции с Plus/Pro billing. Backend-набор — 123/123.

## 0.0.24 — 30 сентября 2026

OpenAPI 0.0.20: AI-беседы получили постоянное чтение и продолжение, два включённых уточнения в фиксированном 10-минутном интервале, ожидание третьего и новый reserve/capture после границы без повторного preview. Добавлены доменные проверки интервала; полный backend-набор — 121/121. Схема остаётся подготовленной v11, PostgreSQL не менялась. Единый список внешних работ: free-tier-todo.md.

## 0.0.23 — 30 сентября 2026

Добавлен выключенный по умолчанию AI reconciliation worker: раз в минуту он освобождает append-only ledger-резерв операций, оставшихся processing более 15 минут, и фиксирует `refunded/process_interrupted`. Проход ограничен 100 операциями, не перекрывается и безопасен при нескольких backend-инстансах. Схема остаётся подготовленной v11; PostgreSQL не менялась, тесты не запускались.

## 0.0.22 — 30 сентября 2026

OpenAPI 0.0.19: AI preview/run доведены до серверной orchestration — снимок согласия, 10-минутный preview, идемпотентный резерв, provider call вне транзакции, атомарные capture/release и точный `refunded` при сбое. Подготовлены migration 011 с immutable cost rule, readiness v11 и минимальные grants; PostgreSQL не менялась. Покупка и reconciliation worker ещё отключены. Тесты не запускались. Подробности: ai.md.

## 0.0.21 — 30 сентября 2026

OpenAPI 0.0.18: AI capabilities, buckets, history, preview/run и test-package contracts; изолированный OpenAI-compatible provider config. Реальное выполнение и покупка fail closed до orchestration/payment adapter. Схема v10 не менялась, миграции не применялись, тесты не запускались. Подробности: ai.md.

## 0.0.20 — 30 сентября 2026

OpenAPI 0.0.17: пользовательские обращения, очереди, переписка, optimistic version/idempotency, редактирование собственного сообщения с закрытой историей, закрытие и возобновление. Использована существующая схема v10; миграции не создавались и не применялись. Реальная загрузка вложений отключена до хранилища и сканера. Тесты не добавлялись и не запускались. Подробности: support.md.

## 0.0.19 — 30 сентября 2026

OpenAPI 0.0.16: пользовательский центр уведомлений, безопасная проекция payload, category/unread pagination, versioned read/read-all и настройки Web Push/email/quiet hours/plan reminder. Внешняя доставка остаётся отключённой. Существующая схема v10 не менялась, миграции не применялись, тесты не добавлялись и не запускались. Подробности: notifications.md.

## 0.0.18 — 30 сентября 2026

OpenAPI 0.0.15: агрегированная личная главная, persisted онбординг 3/5/7 шагов, пищевые предпочтения и редактирование собственного профиля с optimistic version/idempotency. Используется существующая схема v10; миграции не создавались и не применялись. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: personalization.md.

## 0.0.17 — 30 сентября 2026

OpenAPI 0.0.14: прогресс готовки принимает фактическое UTC-время `occurredAt`, чтобы offline-таймеры синхронизировались без сдвига к моменту подключения. Допустимое окно — не старше 30 дней и не более пяти минут в будущем. Схема PostgreSQL не менялась, миграции не применялись, тесты не добавлялись и не запускались.

## 0.0.16 — 30 сентября 2026

Личный план питания Free: день/неделя, ручные слоты, preview/commit, immutable revisions, мягкие резервы и отдельное подтверждение списка покупок. OpenAPI 0.0.13. Схема остаётся подготовленной v10; обновлены только application grants, PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: meal-plan.md.

## 0.0.15 — 30 сентября 2026

Полный онлайн-срез личных покупок и фото-чеков Free: lifecycle и порядок списков, purchase preview/commit, частичная покупка и избыток, receipt review/duplicate link, однократное поступление и позднее уточнение неизвестного количества. OpenAPI 0.0.12. Подготовлена миграция 010 и readiness v10 (184 таблицы/433 FK); PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались.

## 0.0.14 — 29 сентября 2026

Личные заготовки Free: физические банки, неизвестные остатки, preview и атомарный расход, открытие, архив/история, связь с рецептами и расход при готовке. OpenAPI 0.0.11. Подготовлена миграция 009 и readiness v9 (184 таблицы/431 FK); PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: preserves.md и общая итерация.

## 0.0.13 — 29 сентября 2026

Незавершённая готовка: напоминания 2/4 дня, тихие часы 22:00–09:00 локально, архив на шестой день и скрытие через календарный месяц. Пользовательские настройки, внутренние уведомления, фоновая обработка под явным флагом. OpenAPI 0.0.10; схема v8 не меняется, grants подготовлены. По поручению пользователя тесты не добавлялись и не запускались.

## 0.0.12 — 29 сентября 2026

Личный авторинг/версии/модерация, сообщество, готовка и атомарный расход/выход, ручные покупки, общие лимиты с аудитом. OpenAPI 0.0.9. Подготовлена 008, readiness v8; защищён наполняемый production-каталог. БД не менялась. Границы и проверки: ../docs/recipe-workflows-iteration.md.

## 0.0.11 — 29 сентября2026

Recipes list/public detail/personal availability/bookmark, опубликованная revision вместо draft, фильтрация/сортировка до пагинации и отдельный приватный ответ. OpenAPI0.0.8; подготовлена007_recipe_catalog.sql, readinessv7,181таблица/428FK без новых таблиц/FK. РекомендацииTODO; write-рецептов/готовки/покупок нет. PostgreSQL не менялась; результаты финальных проверок фиксируются отдельно.

## 0.0.10 — 28 сентября 2026

Free: личные inventory SQL-команды, места/история/идемпотентность, каталог и собственные pending-предложения, multipart/OCR/табличный импорт с проверкой перед атомарным commit. OpenAPI0.0.7; подготовлена006 metadata партии (181 таблица/428 FK без новых таблиц/FK). Локальные OCR-модели и независимый Linux-перенос. PostgreSQL не менялась, административные workspace503 остаются без persistence. Проверки 28 сентября 2026: back — 74 теста; front — 44 теста; frontend_admin — 81 тест. TypeScript, ESLint, Prettier, CSS lint, генерация контрактов и production-сборки прошли. Дополнительно 13 браузерных сценариев: локальный OCR, EAN13 с изображения, CSV/XLSX/ODS, ручные операции, конфликт двух вкладок, приватность pending-предложения и мобильные страницы. PostgreSQL-интеграция и Linux OCR требуют проверки после отдельно согласованного переноса.

## 0.0.9 — 28 сентября 2026

OpenAPI0.0.6 и защищённые workspace-контроллеры governance/billing/support/content/news/notifications/operations/review для интерфейса административных моков. Новые контроллеры явно возвращают503: production persistence, worker и провайдеры ещё не подключены. Подготовленная SQLv5 не менялась и не применялась; проверки текущего среза фиксируются после завершения прогонов. Матрица: ../docs/admin-ui-readiness.md.

## 0.0.8 — 28 сентября 2026

Добавлена опциональная конфигурация ADMIN_ALLOWED_IPS и глобальная серверная проверка административных маршрутов. Пустой список не ограничивает IP, заполненный допускает только точные IPv4/IPv6. Добавлены проверки подмены forwarded-заголовков, доверенного proxy, IPv6 и сохранения авторизации. Контракт DTO/SQL не менялся; env и инфраструктура не менялись. Инструкция: docs/admin-network.md.

## 0.0.7 — 28 сентября 2026

Основа возвратов и изолированный mock-провайдер: целые суммы, остаток с учётом резервов, идемпотентность и неопределённый исход. Зафиксированы два режима последствий и отложенное подключение оплаты. HTTP/UI и persistence возвратов ещё не подключены; OpenAPI0.0.5 и SQL001–005 не менялись. Проверки и ограничения — docs/payments.md.

## 0.0.6 — 28 сентября 2026

Административный вход по username, отдельная семидневная сессия с доказательством разблокировки вкладки, повторный TOTP и 30-минутное подтверждение критичных действий без пароля. OpenAPI0.0.5. Подготовлена SQL005 и переносv5 (181 таблица/428 FK), без применения. Обычный и moderator auth не менялись; неизвестные критичные команды не включены.

## 0.0.5 — 28 сентября 2026

Изолированный admin/auth, read-проекции16 разделов, согласованные команды поддержки и настройки уведомлений, OpenAPI0.0.4. Подготовлены telemetrySQL004, типы/grants и переносv4 (180 таблиц/427 FK). Критичные неуточнённые команды недоступны. Live БД не менялась; ограничения в docs/admin-read.md.

## 0.0.1 — 25 сентября 2026

Первичная инициализация отдельного backend: NestJS/Fastify/TypeScript, pg/Kysely, единый API и OpenAPI, health, env-валидация, безопасные логи, shutdown, сессии и CSRF, обычный и служебный вход с TOTP/резервными кодами. Добавлены типы схемы, additive SQL 002, план provisioning, собственные линтеры, тесты и CI для общего и будущего отдельного репозитория.

Автономные проверки выполнены; SQL 002 и роль приложения не применены. Проверки PostgreSQL, конкурентного MFA и переноса на Linux остаются открытыми. Версия корневого проекта-рыбы не наследуется. Следующие повышения — только patch.

## 0.0.2 — 25 сентября 2026

Миграции отложены до переноса, добавлены runbook и общая инструкция агента; подготовлены общие HTTP-сценарии для backend и mock. Wire-contract остаётся 0.0.1. PostgreSQL не изменялась; подробности в backend-version-list.md.

## 0.0.3 — 28 сентября 2026

Добавлены GET own/public профилей, строгие DTO и синхронизированные моки, OpenAPI 0.0.2. Front включает страницы профилей, страницу сессий аккаунта и Arc loading-компоненты. Новые тесты приватности, fallback, параметров URL и браузерных состояний. Auth lifecycle ожидает решений пользователя; БД не менялась.

## 0.0.4 — 28 сентября 2026

Account lifecycle, TOTP ordinary login/PIN, управление фактором и резервными кодами, dev-only mailbox, OpenAPI0.0.3. Подготовлены v3 и least-privilege grants, реальная PostgreSQL не менялась. docs/account.md фиксирует границы production и обязательную будущую приёмку.

0.0.107 - 10.14.2026 | 18:15 - Exact live-PG acceptance расширен до 277/347 операций: recipe workspace, family, commerce, cooking/meal-plan/preserves и 37 admin operations; исправлены подтверждённые projection/grant/CAS/jsonb defects. Подготовлен, но не классифицирован незавершённый 32-operation AI/Pro модуль; runtime удалён.

0.0.108 - 10.15.2026 | 18:59 - Exact live-PG классификация завершена: 339 локально исполнимых операций PASS 3×, 5 provider-bound fail-closed и 3 external AI success остаются BLOCKED. Migration 028 и query-оптимизации сокращают shopping 201→1 SQL, family notes 3203→16 строк и исправляют moderator queue correctness/performance; временный PG runtime удалён.
0.0.109 - 10.20.2026 | 21:42 - Синхронизирован least-privilege regression для user_settings с уже действующим точным grant набора timezone/locale/theme/onboarding_state/preferences/version. Backend secrets/generated-types/type/lint/format/build и полный test runner 280/280 PASS; публичные API и SQL grants не изменялись.

0.0.110 - 10.22.2026 | 13:47 - Backend-документация сведена к README, AGENTS и четырём эксплуатационным runbook; удалены устаревшие доменные срезы и дубли журналов без изменения API, runtime и миграций.
