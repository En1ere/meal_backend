# План бесплатных production-checkpoint Meal Planner

Актуально на 7 ноября 2026 года. Этот файл — последовательный tracker работ, которые не требуют покупки платёжного, кассового, AI или инфраструктурного сервиса. Корень `test-roject` остаётся read-only; изменения выполняются в самостоятельных репозиториях.

## Правила выполнения

1. Одновременно активен один checkpoint. Следующий начинается после CI, deploy, smoke, документации и rollback/disable evidence текущего.
2. Секреты не передаются в чате и не коммитятся. Они сохраняются в GitHub Environment и root-owned server secret files.
3. Provider-bound функция остаётся fail-closed, пока нет реального adapter, timeout/unknown/retry/reconciliation тестов и наблюдаемости.
4. Платежи, ККТ, merchant secrets и утверждение юридических реквизитов не входят в этот план.

## Последовательность

| №   | Checkpoint                          | Статус              | Критерий завершения                                                                                                                                          |
| --- | ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Предварительные legal-тексты        | выполнено           | 11 публичных draft-страниц, единая заглушка, `draft_blocked`, нет production acceptance evidence                                                             |
| 2   | Остаточный архитектурный checkpoint | выполнено           | architecture gates трёх репозиториев, декомпозиция подтверждённых hotspots, без wire/URL изменений                                                           |
| 3   | Workers и scheduler                 | выполнено           | отдельный hardened worker container, fail-closed allowlist, PostgreSQL lease/fencing, restart/overlap/timeout/poison tests                                   |
| 4   | Observability в admin               | выполнено           | backend/VPS collector и admin UI развёрнуты; auth, real snapshot, Docker/systemd, partial/atomic и CI/CD evidence пройдены                                   |
| 5   | Транзакционная почта                | ждёт owner inputs   | Outbox, worker, SMTP adapter и failure semantics развёртываемы; реальная доставка ждёт provider, sender DNS и secret                                         |
| 6   | Storage и malware scanner           | free scope выполнен | 6A и schema v33 развёрнуты; isolated CDR capacity/OOM/restart принят, публикация ждёт scanner/policy                                                         |
| 7   | Локальный OCR                       | выполнено           | RU/EN worker, всегда `requiresReview`, resource limits, duplicate/timeout/OOM tests                                                                          |
| 8   | Web Push                            | выполнено           | VAPID, encrypted session-bound subscriptions, quiet hours, TTL/topic policy, 404/410 cleanup, admin registry и VPS worker                                    |
| 9   | Локальная backup-структура          | выполнено           | encrypted local repository, PostgreSQL/media/manifests, retention, disk guard и restore drill; честный `offsite: false`                                      |
| 10  | AI                                  | free scope выполнен | тарифные task/context policies, async lifecycle, worker isolation, stop-loss, eval-контур и retention развёрнуты; реальный provider ждёт key/budget/evidence |
| 11  | Reliability и сквозная приёмка      | выполнено           | CI, E2E, provider failure drills, load/OOM/leak tests, browser/accessibility, VPS restart/rollback                                                           |
| 12  | Документация                        | постоянно           | runbook, owner inputs, env/secret inventory, disable/rollback и manual tests обновляются в каждом checkpoint                                                 |

Следующая рабочая сессия начинается с последовательного согласования [AI provider activation roadmap](AI_ACTIVATION_ROADMAP.md). Реализация приостановлена до решений по продуктовым сценариям/тарифам, provider/model routing, данным, quality/safety, бюджету и `unknown/reconciliation_hold`. Цель подготовки — fail-closed release, которому для controlled activation не хватает только значения API key и реального provider evidence.

## Checkpoint 11: итог 3 ноября 2026

- Backend `npm run check` прошёл полностью: architecture gate, typecheck, lint/format и 395/395 тестов. Dependency audit — 0 уязвимостей. OpenAPI `0.0.65`, schema `v34` и generated client фронта сверены; расхождение устаревшего frontend snapshot `0.0.64` устранено без изменения backend wire-контракта.
- Admin Edge desktop/mobile: основной reliability pack 28/28 и отдельный recipe moderation pack 10/10. Client Edge desktop/mobile: ранее пройденные 20 сценариев плюс возобновлённые 61/66 и исправленный focused повтор 6/6; пять первоначальных падений были устаревшими assertions, а не runtime-дефектами.
- Production budgets прошли: admin max gzip chunk 88,287 B, total gzip 224,641 B; client max gzip chunk 124,355 B, total gzip 878,982 B, max route 377,960 B. Сохранённое evidence 30-минутного browser soak подтверждает bounded heap/DOM/listeners без линейного роста.
- На VPS PostgreSQL и семь application/storage containers контролируемо перезапущены. Schema/users/recipes до и после совпали (`34|1|0`), все containers вернулись в `healthy`, `verify.sh --component all` прошёл. Frontend application-only rollback на предыдущий immutable digest и roll-forward на текущий digest прошли без изменения PostgreSQL.
- Три read-only load-волны подтвердили нормальную обработку первых 600 запросов; затем публичный `/health/ready` корректно сработал по глобальному лимиту 200 запросов/минуту на IP и вернул `429`. После окна limiter `ready`, frontend и admin снова вернули `200`; RSS/PID остались bounded, полный deployment verify повторно прошёл.
- `meal-local-backup.timer` включён и активен, последний service result — success, два encrypted restic snapshot читаются, следующий запуск назначен на 01:00 Asia/Yekaterinburg. Unit намеренно называется `meal-local-backup.*`, а не `meal-planner-local-backup.*`.

Внешними release gates остаются только явно исключённые owner/provider задачи: payment/ККТ, реальные SMTP и sender DNS, активация OpenAI и provider evidence, malware scanner/public media policy, offsite backup, финальные юридические реквизиты, custom-domain DNS cutover и физическая screen-reader/device приёмка. Архитектурный этап выполнен по согласованным правилам; оставшееся операторское действие для `unknown/reconciliation_hold` требует отдельного решения из-за финансовых последствий.

## Что потребуется от владельца

### Legal — позже, для снятия `draft_blocked`

- наименование или ФИО ИП, ИНН, ОГРН/ОГРНИП, юридический и почтовый адрес;
- support email и отдельный privacy/data-subject email;
- дата публикации, дата действия и approval reference;
- сроки хранения/удаления, subprocessors, регионы и политика трансграничной передачи;
- детский возрастной порог и способ проверки представителя;
- независимое юридическое утверждение.

До получения этих данных используется только `[Тут будут данные]`, а registration/consent остаются fail-closed.

### Observability

- канал срочных уведомлений: email, Telegram или другой webhook;
- получатель/чат и секрет канала — только через secret store;
- желаемые пороги. Без отдельного решения применяются консервативные технические defaults и admin-only отображение.

### Транзакционная почта

- sender domain и доступ к DNS;
- `From` name/address, `Reply-To`, support/privacy/security addresses;
- выбор SMTP/API provider либо подтверждение self-hosted SMTP;
- host/port/login/password или API key через secret store;
- возможность настроить SPF, DKIM, DMARC и, для self-hosted SMTP, PTR/rDNS у VPS-провайдера.

Без DNS/PTR реальную доставляемость нельзя считать закрытой, даже если приложение и outbox работают.

### Storage и scanner

- общий допустимый объём хранилища;
- retention для avatar, community, support, receipt и export;
- допустимые MIME и размеры по назначению. До решения действует текущий безопасный hard cap; CDN пока не требуется.
- согласие на additive asset lifecycle API: reservation, byte upload, completion/status и scoped download;
- решение по scanner capacity: текущий VPS имеет 1.9 GiB RAM, тогда как официальный минимум ClamAV — 3 GiB, рекомендуемый объём — 4 GiB.

До согласования контрактов безопасный вариант — подготовить encrypted local adapter с отдельными `tmp`, `quarantine` и `ready`, но не публиковать assets. Автоматическое физическое удаление не включается до утверждения retention/legal-hold policy.

### OCR

- приоритетные документы: чеки, этикетки, рукописные списки;
- языки, допустимое время обработки и retention исходника.

Рекомендуемый старт: чеки и этикетки, RU+EN, один активный job, ручное подтверждение всегда.

### Web Push

- VAPID subject, обычно `mailto:security@domain`;
- контактный email;
- quiet hours/TTL policy либо согласие на безопасные defaults;
- разрешение сгенерировать VAPID key pair и хранить private key только в server/GitHub secrets.

### Локальный backup

- временные RPO/RTO;
- retention и ответственный за recovery password;
- позже: S3/SFTP endpoint, bucket/path, region, credentials, immutable retention и отдельный restore target.

Принятый временный baseline: запуск ежедневно в `01:00 Asia/Yekaterinburg`, RPO 24 часа, RTO 4 часа, 7 daily и 4 weekly. Recovery password генерируется на VPS и не выводится; независимый offsite target остаётся будущим owner/infrastructure checkpoint.

### AI — активация внешнего provider

- production OpenAI API key, переданный только через root-owned secret/GitHub Environment;
- положительный месячный `AI_MONTHLY_BUDGET_USD` и владелец budget alerts;
- подтверждение допустимого региона и provider data controls для Responses API с `store: false`;
- реальный Luna evidence на неизменном `ai-model-eval-v1`; Sol сравнивается только на тех же fixtures и не включается автоматически;
- решение по операторскому readback/release для `unknown/reconciliation_hold`: без ручной подделки success и без повторного provider submit.

Принятый baseline уже зафиксирован: OpenAI Responses API, `gpt-6-luna` с low reasoning, профиль `openai-gpt-6-luna-standard-2026-11-07`, доступность задач строго по текущему тарифу и минимизированный versioned context. Контент AI очищается через 30 дней с учётом legal hold; финансовое и provider evidence сохраняется. Пока нет key, положительного бюджета и provider evidence, AI-worker остаётся fail-closed.

## Уже закрыто

Docker cutover, TLS/Nginx на технических origins, least-privilege DB roles, main-to-digest autodeploy, container health/readiness, pre-rollout DB backup/restore drill, admin MFA и theme smoke не выполняются повторно без изменения соответствующего слоя. Фактические версии и schema после каждого rollout фиксируются в `DEPLOYMENT.md`; custom-domain cutover остаётся отдельным pending шагом до публикации DNS A-записей.

Legal checkpoint опубликован как явно неутверждённый draft-каталог: все 11 документов доступны для чтения, содержат единую заглушку `[Тут будут данные]`, закрыты от индексации и не используются как production acceptance evidence.

Архитектурный checkpoint закрыт без изменения HTTP/API, DB schema, URL и wire payload: backend gate подтверждает 60 доменов без циклических групп и запрещает `modules -> app`; admin gate контролирует static/dynamic imports, public feature API и mock boundaries; frontend gate контролирует app/widgets public API и отдельный mock entry. Доказанно смешанные route/release/runtime модули декомпозированы с сохранением публичных экспортов и поведения.

Observability checkpoint полностью развёрнут и принят на VPS: host bootstrap, root-owned atomic snapshot, Docker read-only mount, systemd collector/timer, degraded partial state, rollback и real admin+MFA smoke подтверждены. Admin-only read endpoint транзакционно проверяет live admin/MFA/session и пишет audit; host/DB/queue/worker/provider данные имеют fixed enums, bounded cardinality и явные freshness states. Внешний alert channel остаётся выключенным до выбора владельцем канала, получателя, secret и порогов и не переоткрывает admin-only checkpoint.

Транзакционная account-mail foundation подготовлена в backend `0.0.151+`: migration 031, atomic PostgreSQL outbox, append-only attempts, отдельные token/runtime credentials, lease/CAS, bounded retry, terminal `unknown`, deterministic Message-ID, verified TLS/timeouts и четыре allowlisted шаблона. Mail-worker остаётся выключенным до получения SMTP provider credentials, sender domain, SPF/DKIM/DMARC и реального test inbox; это внешняя активация, а не незавершённая имитация доставки.

Checkpoint 6A закрыт на private SeaweedFS 4.51. Бесплатная часть 6B также принята: schema v33, отдельные DB/SeaweedFS identities, image-only JPEG/PNG/WebP CDR, immutable binding к intake/diary/support/avatar, `inventory_source`, quotas и append-only reconciliation evidence. На VPS подтверждены hardened container bounds, 12 MP JPEG/PNG/WebP, cgroup OOM isolation, стабильный RSS и автоматическое восстановление после crash; очередь осталась пустой, API — healthy. CDR-статус `cdr_reencoded` намеренно не выдаётся за antivirus-clean. Фото чека/инвентаря сначала принадлежат pre-domain `media_intake`; OCR и доменная запись требуют human review. Processor и пользовательский media API снова выключены после drill. PDF/video/HEIC/community publication и ClamAV остаются закрыты до scanner/явно согласованной non-public policy; media backup остаётся checkpoint 9.

Checkpoint 7 закрыт на VPS как несохраняемый OCR preview: RU+EN модели проверяются по manifest/SHA-256 до startup, один job работает в no-egress/no-DB/no-storage sidecar с 512 MiB/0.75 CPU/64 PID. Реальный authenticated HTTPS scan распознал синтетический RU+EN fixture с confidence 96 и literal `requiresReview: true`; счётчики media/intake/recognition/receipt/inventory до/после остались равными. Wrong token дал 401, параллельный job — 503 busy, process crash увеличил restart count и вернул healthy, отдельный 64 MiB OOM drill завершился 137 без остаточного контейнера; full deploy verify и public front/admin health прошли. Durable originals/public assets по-прежнему закрыты checkpoint 6 scanner gate.

Checkpoint 8 закрыт на VPS: VAPID и encryption keys хранятся только в root-owned secrets, schema v34 применена, отдельный least-privilege push-worker развёрнут и после реального empty-cycle имеет health `ok`. Исправлены обнаруженные production gaps упаковки worker scripts, `pgcrypto` migration dependency и узкий column-level privilege для append-only attempts; полный табличный доступ worker не получил.

Checkpoint 9 закрыт на VPS с restic 0.16.4. Persistent systemd timer назначен на `01:00 Asia/Yekaterinburg`; unit имеет systemd exposure `4.3 OK`. Два реальных encrypted snapshot прошли exact readback, repository check и retention без plaintext residue; последний изолированный restore восстановил schema/table/FK/PostgreSQL invariants `34/227/519/18` за 6 секунд, не меняя source. Disposable container и restore directory удалены, полный application verify после backup прошёл. Status хранится `root:meal-observability 0640`, recovery password — `root:root 0600`; admin всегда показывает `offsite=false` и blocker `offsite_target_missing`. Политика, install/disable и restore runbook описаны в `LOCAL_BACKUP.md`.

Checkpoint 10 закрыт в бесплатном техническом scope на schema v38. `ai-task-policy-v3` авторизует 18 типов задач по effective Free/Plus/Pro entitlement, а `ai-context-policy-v1` фиксирует минимизированные источники и consent evidence; две задачи без достоверного source contract остаются fail-closed. Canonical async operations используют отдельный least-privilege AI worker, lease/fencing, Background Responses readback, независимые lifecycle/financial states и conservative monthly stop-loss. Admin получает только агрегированный read-only control plane. Offline `ai-model-eval-v1` сравнивает Luna/Sol на восьми одинаковых safety/quality fixtures без raw prompt/result, а daily retention необратимо очищает AI content после 30 дней, сохраняя legal hold и финансово-операционное evidence. На VPS применены 38 миграций (`228` таблиц, `522` FK), retention smoke и общий deployment verify прошли; реальный provider call намеренно не выполнялся без key и утверждённого бюджета.
