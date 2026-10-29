# Operational maintenance entrypoints

Этот документ описывает server entrypoint-ы и отдельный production scheduler container; scheduler не применяет миграции PostgreSQL и не открывает HTTP ingress.

## Worker topology

Versioned manifest `src/modules/operational-runtime/worker-topology.ts` перечисляет восемь external one-shot entrypoint-ов и два opt-in embedded loop-а. Для каждого закреплены batch/timeout/minimum interval, requirements и overlap policy; все выключены по умолчанию. `npm run ops:topology` только собирает и печатает manifest, не создаёт application context и не открывает БД. One-shot planner требует точную topology version и `apply=true`, ограничивает batch/timeout, не принимает embedded loop и требует versioned destructive approval только для account retention. Это deployment contract, не установленный scheduler.

Все восемь `--apply` entrypoint-ов проходят через общий `executeOneShotWorker`: получают PostgreSQL lease, продлевают его, наблюдают topology deadline, освобождают lease после завершения и формируют строгий run observation. Deadline намеренно не обрывает продолжающуюся mutation внутри процесса: executor ждёт её завершения и всё это время продлевает lease, затем возвращает `timeout` и ненулевой exit code. Hard timeout принадлежит внешнему scheduler и должен завершать весь процесс; после аварийной остановки lease остаётся занятым до TTL. Это исключает возврат executor-а и новый overlap, пока старая mutation ещё может продолжаться.

Пересекающийся запуск завершается `skipped_overlap`; отсутствие lease storage — `skipped_not_ready` и ненулевой exit code. Stdout содержит только status и schema-validated observation без domain result, stderr — JSON `worker.run`/`worker.alert` без payload, credentials, URL и пользовательских идентификаторов. Ошибка telemetry sink не меняет результат доменной задачи.

Migration `024_worker_leases.sql`, входящая в текущий schema-v29 baseline, добавляет только shared lease state с PostgreSQL clock и монотонным fencing token. Renew/release требуют точные task, owner, lease id и fencing token; истёкший lease можно атомарно перехватить с увеличением token. Application role получает SELECT/INSERT и точечный UPDATE, без DELETE/DDL. Deployment обязан подтвердить schema version не ниже 24; на более старой схеме one-shot `--apply` fail closed как `lease_unavailable`, а plan-only команды БД не открывают.

`SanitizedJsonWorkerRuntimeSink` остаётся резервным provider-neutral каналом. Composition root объединяет его с first-party sink, который сохраняет только schema-validated метрики и алерты в административные таблицы.

Offline `npm run ops:readiness` отмечает PostgreSQL lease и этот telemetry/alert fanout как готовые repository capabilities. Они не входят во внешние blockers; команда остаётся `blocked_external`, пока отсутствуют подтверждённые RPO/RTO, backup/key custody, isolated restore target и production HTTPS origins.

`executeEmbeddedWorker` предоставляет ту же shared-lease/deadline/observation границу для `ai-reconciliation` и `cooking-lifecycle`; оба application service подключены к ней. До применения v24 их activation flags остаются выключенными. В production включение также требует стабильного `WORKER_OWNER_ID`.

Owner lease по умолчанию равен локальному `worker-<pid>`. Deployment scheduler может задать безопасный неперсональный `WORKER_OWNER_ID` по шаблону `[a-z][a-z0-9-]{2,63}`; значение используется только для владения lease и не попадает в observation/alert.

## Production scheduler container

`scripts/run-worker-scheduler.mjs` — единственный long-running scheduler. Он запускается отдельным non-root/read-only контейнером на том же immutable backend image, имеет только `meal-db`, не публикует порт и получает только `backend_database_url`. Полный `AppModule`, auth/MFA secrets и provider credentials worker-у не передаются; one-shot child использует минимальный `WorkerModule`.

По умолчанию `WORKER_SCHEDULE_ALLOWLIST` пуст: контейнер пишет heartbeat, но не выполняет мутации. Разрешены только `scheduled-news`, `incident-ignore-expiry`, `scheduled-sanctions`, `diary-portions`, `cooking-lifecycle`. Email, exports, retention, account retention и AI отклоняются parser-ом независимо от interval-переменных. API container обязан явно держать `AI_RECONCILIATION_ENABLED=false` и `COOKING_LIFECYCLE_ENABLED=false`; scheduler также отказывается стартовать при включённом embedded mode.

Каждый запуск выполняется в отдельном child process через `scripts/run-scheduled-task.mjs`. Внутри child `WorkerRuntimeFactory` получает PostgreSQL lease/fencing и admin+JSON telemetry; scheduler держит глобальную concurrency `1`, а DB pool первого cutover ограничен двумя соединениями. Первый запуск каждой задачи наступает только после полного interval+jitter, поэтому restart не создаёт стартовый burst. Следующий interval/backoff отсчитывается от фактического завершения child, без немедленного catch-up после долгой работы. Hard deadline равен topology timeout плюс 10 секунд: сначала child получает `SIGTERM`, через 5 секунд — `SIGKILL`. Незавершённый lease остаётся до TTL, поэтому restart/kill не создаёт overlap. `skipped_overlap` переносит следующий запуск, но не сбрасывает историю ошибок и poison state; timeout, lease unavailable/lost, partial и failure получают exponential backoff. После трёх последовательных ошибок только этот task изолируется на 15 минут, остальные продолжают работу.

Health evidence атомарно пишется в tmpfs `/run/meal-worker/health.json`: только fixed task id, timestamps, outcome, bounded failure count и poison deadline. Payload, URL, credentials, owner id и domain identifiers запрещены. Healthcheck требует свежий heartbeat и состояния `idle|running`; во время долгого child-run heartbeat обновляется независимо.

Безопасные минимальные интервалы: news/sanctions/diary/cooking — 60 секунд, incidents — 300 секунд. Override принимается только целым числом не меньше topology minimum; jitter 0–30 секунд, maximum backoff 60–3600 секунд, poison threshold 1–10 и shutdown grace 5–120 секунд.

Emergency disable без смены image: установить `WORKER_SCHEDULE_ALLOWLIST=` и пересоздать только worker. Для полной остановки: `docker compose ... stop --timeout 45 worker`. Lease не удалять вручную; дождаться TTL и проверить health/telemetry. Повторное включение выполняется по одному task id после проверки предыдущего outcome. Rollback backend digest атомарно возвращает одновременно backend и worker, так как они используют один image.

`account-retention` не входит в scheduler allowlist. Даже ручной `--apply` теперь дополнительно требует `WORKER_OWNER_ID`, `--approval-ticket=...` и `--approval-policy-version=...`, проходящие versioned destructive planner.

## Запланированные новости

`ScheduledNewsRunner.runDue(limit, clock)` выбирает только наступившие `scheduled`-новости через
`FOR UPDATE SKIP LOCKED`. Получатели вычисляются в момент запуска. In-app уведомления имеют стабильный
`dedup_key` по announcement/revision/user и вставляются через `ON CONFLICT DO NOTHING`, поэтому повторный или
параллельный запуск не создаёт дубли.

Email и push остаются fail-closed: поставить такую новость в расписание нельзя, а runner пропускает старую
некорректную запись, не помечая её опубликованной. Администраторская команда `launch` теперь либо публикует
in-app новость немедленно, либо сохраняет будущий `scheduledAt` после критического подтверждения.

`ScheduledNewsRunner` зарегистрирован в `AppModule`. Защищённый scheduler должен вызывать `runDue` ограниченными
пачками; ручной entrypoint — `npm run ops:news -- --apply`. Без `--apply` команда только печатает план. HTTP endpoint
для worker не требуется.

## Истёкший ignore и retention

`OperationalMaintenanceService.restoreExpiredIncidentIgnores()` атомарно возвращает наступившие ignored-инциденты
в `new`, очищает назначение и пишет системный audit event. Выборка ограничена, заблокирована через
`SKIP LOCKED`, повторный запуск безопасен.

Три retention entrypoint-а:

- `runAdminErrorRetention()`;
- `runAdminMetricRetention()`;
- `runFileMetadataRetention()`.

Они читают включённую и вступившую в силу запись `feature_rule_versions` с ключами соответственно
`admin_errors_retention`, `admin_metrics_retention`, `file_metadata_retention` и правилом
`{ "retentionDays": number }`. До опубликованной записи возвращается `policy_unconfigured`. После неё entrypoint
работает только как `dry_run`: считает кандидатов, но всегда возвращает `deleted: 0`. Это намеренно — таблицы
телеметрии append-only, а media metadata может иметь ссылки. Удаление потребует отдельной миграции с archive/delete
семантикой и разрешения на применение БД.

`OperationalMaintenanceService` зарегистрирован в `AppModule`. Ручные entrypoint-ы: `npm run ops:incidents --
--apply` для восстановления истёкших ignore и `npm run ops:retention -- --apply` для безопасной
retention-инспекции. Без `--apply` обе команды только печатают план и не подключаются к БД.

## Registration risk policy

`RegistrationRiskPolicy` отделён от account workflow и принимает подключаемый `RegistrationRiskProvider`.
Провайдер возвращает только нормализованные сигналы: disposable-email, risk score и результат CAPTCHA. В проекте
нет встроенного blocklist, CAPTCHA-клиента или внешнего вызова.

Server config валидируется общим `readConfig(process.env)` и передаётся в `registrationRiskConfig(config)`:

| Переменная                            | Значение                             | По умолчанию  |
| ------------------------------------- | ------------------------------------ | ------------- |
| `REGISTRATION_RISK_ENABLED`           | `true` / `false`                     | `false`       |
| `REGISTRATION_RISK_FAILURE_MODE`      | `fail_closed` / `fail_open`          | `fail_closed` |
| `REGISTRATION_DISPOSABLE_EMAIL_CHECK` | `true` / `false`                     | `true`        |
| `REGISTRATION_CAPTCHA_MODE`           | `disabled` / `risk_based` / `always` | `risk_based`  |
| `REGISTRATION_DENY_RISK_SCORE`        | число от `0` до `1`                  | `0.9`         |

При включённой политике отсутствие/сбой провайдера блокирует регистрацию в `fail_closed` и допускает её с явной
причиной `provider_unavailable_fail_open` в `fail_open`. Политика не считает отсутствующую CAPTCHA успешной.

Policy зарегистрирована и вызывается из `AccountService.register` до хеширования пароля. Сейчас provider равен
`null`: при `REGISTRATION_RISK_ENABLED=true` поведение определяется выбранным failure mode. После выбора провайдера
нужно заменить только provider factory и передавать CAPTCHA token через отдельно согласованный контракт
регистрации. Пока `REGISTRATION_RISK_ENABLED=false`, существующее поведение не меняется.

## Публичная статистика готовки

`CookingStatisticsPolicy` читает последнюю включённую запись `feature_rule_versions` с ключом
`cooking_statistics_publication` и правилом `{ "minimumSample": 3 }`. Встроенное versioned-правило v1 также равно
трём наблюдениям и используется, пока опубликованной записи нет. Некорректная опубликованная запись закрывает
endpoint с `503`, а не ослабляет порог. `CookingService` больше не содержит магическое число и скрывает
median/quartiles до достижения актуального порога.

`CookingStatisticsPolicy` зарегистрирована в `AppModule`; optional builtin fallback оставлен для изолированного
использования `CookingService` и сохраняет точное правило v1.
