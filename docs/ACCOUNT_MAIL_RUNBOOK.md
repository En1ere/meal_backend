# Транзакционная почта аккаунта

## Граница и безопасный режим

Публичный HTTP API не изменён. В production создание `verify`, `reset`, `email-confirm` и `email-cancel` token в той же `SERIALIZABLE`-транзакции создаёт запись `account_mail_deliveries`. SMTP вызывается только отдельным worker после commit. По умолчанию `ACCOUNT_MAIL_ENABLED=false`: production account-mail операции fail closed с `503`, а обычный backend и существующий deployment продолжают запускаться без SMTP secret.

Migration 031 намеренно отзывает все неиспользованные legacy account tokens: их ciphertext был создан MFA-ключом. Новые production tokens имеют `cipher_key_version=2` и шифруются только `ACCOUNT_MAIL_TOKEN_KEY`; worker не получает MFA/security/session secrets. После миграции пользователь безопасно запрашивает новую ссылку.

## Данные оператора

Нужны: SMTP host/port, username, password, подтверждённый From и при необходимости Reply-To. Password, отдельный случайный 32-byte base64 account-mail key и DB URL кладутся в root-owned файлы `/etc/meal-planner/secrets/{smtp-password,account-mail-token-key,mail-worker-database-url}` с mode `0640`. Нельзя переиспользовать MFA key или общий backend login.

Сначала, пока `ACCOUNT_MAIL_ENABLED=false`, создать отдельный 32-byte lowercase-hex пароль `/etc/meal-planner/secrets/mail-runtime-database-password` (`root:meal-secrets`, `0640`) и выполнить `sh deploy/provision-account-mail-runtime.sh`. Скрипт создаёт login `meal_mail_runtime` без наследования, выдаёт ему только право `SET ROLE meal_mail_worker`, явно отбирает `meal_app` и атомарно формирует `mail-worker-database-url` с URL-encoded `options=-c role=meal_mail_worker`. Компрометация SMTP worker поэтому не даёт прав HTTP backend.

Запуск выполняется только после проверки DNS/SPF/DKIM/DMARC и теста в Mailpit/local sink:

```sh
sh deploy/provision-account-mail-runtime.sh
# Затем добавить SMTP_* и ACCOUNT_MAIL_ENABLED=true в root-owned deploy.env.
docker compose -f deploy/compose.production.yml -f deploy/compose.account-mail.yml --profile mail config
sh deploy/deploy.sh --component backend --image <immutable-backend-digest> --revision <git-sha>
sh deploy/verify.sh --component backend
```

Обычный автодеплой читает `ACCOUNT_MAIL_ENABLED` из `/etc/meal-planner/deploy.env`: при `true` он автоматически подключает `compose.account-mail.yml`, обновляет и проверяет `backend`, `worker` и `mail-worker` одним immutable digest. При `false` override и SMTP secrets не требуются, account-mail операции остаются fail closed.

Для Mailpit/local sink сначала соберите backend и запустите loopback Mailpit на порту 1025, затем выполните `node scripts/smoke-account-mail-smtp.mjs`. Harness отказывается от non-loopback host и отправляет ровно четыре allowlisted template на `acceptance@example.test`; проверьте в UI Mailpit text/HTML, HTTPS links и разные subjects. TLS отключён только в этом loopback acceptance harness. Production parser всегда требует verified TLS (TLS >= 1.2), bounded connect/greeting/socket timeouts.

## Delivery semantics и наблюдение

Claim использует `FOR UPDATE SKIP LOCKED`, lease token и compare-and-set. Два worker не могут одновременно владеть delivery. Ограниченная `MAIL_WORKER_BATCH_SIZE` пачка обрабатывается параллельно, поэтому письма не теряют общую lease в ожидании предыдущего SMTP handshake. 4xx SMTP планирует bounded exponential retry; явный 5xx terminal. Timeout/socket/неизвестный результат после возможной SMTP acceptance становится terminal `unknown` и автоматически не отправляется повторно. Crash с истёкшим processing lease также становится `unknown`. Expired/revoked/used/legacy token помечается `skipped`. Message-ID детерминирован от delivery UUID.

Логи содержат только low-cardinality `mail_worker cycle_failed`/database state, без адресов, token, SMTP response и ciphertext. Детальная sanitized история находится в append-only `account_mail_attempts`; unknown требует ручной сверки с SMTP provider до любого нового запроса пользователя.

Rollback приложения: остановить `mail-worker`, вернуть `ACCOUNT_MAIL_ENABLED=false` и старый image. Migration 031 не откатывать: таблицы и отозванные legacy tokens безопасно остаются; новые письма не создаются, операции fail closed.
