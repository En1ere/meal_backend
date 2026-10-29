# План бесплатных production-checkpoint Meal Planner

Актуально на 29 октября 2026 года. Этот файл — последовательный tracker работ, которые не требуют покупки платёжного, кассового, AI или инфраструктурного сервиса. Корень `test-roject` остаётся read-only; изменения выполняются в самостоятельных репозиториях.

## Правила выполнения

1. Одновременно активен один checkpoint. Следующий начинается после CI, deploy, smoke, документации и rollback/disable evidence текущего.
2. Секреты не передаются в чате и не коммитятся. Они сохраняются в GitHub Environment и root-owned server secret files.
3. Provider-bound функция остаётся fail-closed, пока нет реального adapter, timeout/unknown/retry/reconciliation тестов и наблюдаемости.
4. Платежи, ККТ, merchant secrets и утверждение юридических реквизитов не входят в этот план.

## Последовательность

| №   | Checkpoint                          | Статус            | Критерий завершения                                                                                                        |
| --- | ----------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Предварительные legal-тексты        | выполнено         | 11 публичных draft-страниц, единая заглушка, `draft_blocked`, нет production acceptance evidence                           |
| 2   | Остаточный архитектурный checkpoint | выполнено         | architecture gates трёх репозиториев, декомпозиция подтверждённых hotspots, без wire/URL изменений                         |
| 3   | Workers и scheduler                 | выполнено         | отдельный hardened worker container, fail-closed allowlist, PostgreSQL lease/fencing, restart/overlap/timeout/poison tests |
| 4   | Observability в admin               | выполнено         | backend/VPS collector и admin UI развёрнуты; auth, real snapshot, Docker/systemd, partial/atomic и CI/CD evidence пройдены |
| 5   | Транзакционная почта                | ждёт owner inputs | Outbox, worker, SMTP adapter и failure semantics развёртываемы; реальная доставка ждёт provider, sender DNS и secret       |
| 6   | Storage и malware scanner           | согласование      | Нужны additive media API и scanner capacity; до решения реальные assets остаются fail-closed                               |
| 7   | Локальный OCR                       | очередь           | RU/EN worker, всегда `requiresReview`, resource limits, duplicate/timeout/OOM tests                                        |
| 8   | Web Push                            | очередь           | VAPID, subscription lifecycle, quiet hours, TTL/topic policy, 404/410 cleanup                                              |
| 9   | Локальная backup-структура          | очередь           | encrypted local repository, PostgreSQL/media/manifests, retention, disk guard и restore drill; честный `offsite: false`    |
| 10  | AI                                  | отложено          | отдельный epic после workers/telemetry/storage; сначала use cases, privacy, quality и resource baseline                    |
| 11  | Reliability и сквозная приёмка      | очередь           | CI, E2E, provider failure drills, load/OOM/leak tests, browser/accessibility, VPS restart/rollback                         |
| 12  | Документация                        | постоянно         | runbook, owner inputs, env/secret inventory, disable/rollback и manual tests обновляются в каждом checkpoint               |

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

Рекомендуемый временный baseline: RPO 24 часа, RTO 4 часа, 7 daily и 4 weekly. Он становится принятой policy только после подтверждения владельцем.

### AI — отдельный будущий epic

- точный список use cases и разрешённые данные для каждого;
- local/external/hybrid режим;
- задержка, quality baseline, moderation и consent policy;
- provider/model/region/training/retention;
- per-user и месячный budget/stop-loss.

## Уже закрыто

Docker cutover, TLS/Nginx на технических origins, schema v31, least-privilege DB roles, main-to-digest autodeploy, container health/readiness, pre-rollout DB backup/restore drill, admin MFA и theme smoke не выполняются повторно без изменения соответствующего слоя. Backend `0.0.152`, admin `0.0.128` и frontend `0.0.152` прошли CI/CD и сокращённый public/container smoke; custom-domain cutover остаётся отдельным pending шагом до публикации DNS A-записей.

Legal checkpoint опубликован как явно неутверждённый draft-каталог: все 11 документов доступны для чтения, содержат единую заглушку `[Тут будут данные]`, закрыты от индексации и не используются как production acceptance evidence.

Архитектурный checkpoint закрыт без изменения HTTP/API, DB schema, URL и wire payload: backend gate подтверждает 60 доменов без циклических групп и запрещает `modules -> app`; admin gate контролирует static/dynamic imports, public feature API и mock boundaries; frontend gate контролирует app/widgets public API и отдельный mock entry. Доказанно смешанные route/release/runtime модули декомпозированы с сохранением публичных экспортов и поведения.

Observability checkpoint полностью развёрнут и принят на VPS: host bootstrap, root-owned atomic snapshot, Docker read-only mount, systemd collector/timer, degraded partial state, rollback и real admin+MFA smoke подтверждены. Admin-only read endpoint транзакционно проверяет live admin/MFA/session и пишет audit; host/DB/queue/worker/provider данные имеют fixed enums, bounded cardinality и явные freshness states. Внешний alert channel остаётся выключенным до выбора владельцем канала, получателя, secret и порогов и не переоткрывает admin-only checkpoint.

Транзакционная account-mail foundation подготовлена в backend `0.0.151+`: migration 031, atomic PostgreSQL outbox, append-only attempts, отдельные token/runtime credentials, lease/CAS, bounded retry, terminal `unknown`, deterministic Message-ID, verified TLS/timeouts и четыре allowlisted шаблона. Mail-worker остаётся выключенным до получения SMTP provider credentials, sender domain, SPF/DKIM/DMARC и реального test inbox; это внешняя активация, а не незавершённая имитация доставки.

Storage-аудит подтвердил, что существующие diary/support/receipt/export контракты передают только метаданные или inline content и не имеют безопасного byte-upload lifecycle. Полное включение требует согласованного additive API и отдельного media worker. MinIO community binaries больше не являются поддерживаемой основой; возможны encrypted local adapter для временного VPS либо актуальный S3-compatible provider. ClamAV на текущих 1.9 GiB RAM production-safe не включается.
