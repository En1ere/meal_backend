# Backup and recovery contract

Кодовый этап 14 определяет строгую provider-neutral границу, но не утверждает production provider или цели восстановления.

Recovery set v4 содержит PostgreSQL custom dump, media archive, media manifest, migration manifest и grants manifest. Каждый artifact обязан быть зашифрованным, immutable, offsite, иметь SHA-256, размер, opaque locator и retention policy version. Секреты всегда исключены и восстанавливаются отдельным защищённым процессом. Evidence v1/v2/v3 fail closed и не переносится на новую схему.

Restore drill разрешён только в пустую изолированную `ephemeral_test` базу PostgreSQL 18 с именем `meal_planner_postgres`, change ticket и запретом изменения источника. Успешное evidence привязано к точным policy version, snapshot time и migration-manifest checksum; также требуются проверки всех hashes, schema v26, 209 таблиц, 482 FK, ограниченной application-role, domain smoke и покрытия media. Unknown outcome сначала сверяется; restore автоматически не повторяется.

RPO/RTO не имеют инженерных значений по умолчанию. Production readiness остаётся `objectives_unapproved`, пока владелец не утвердит versioned policy. Даже после этого нужны свежий recovery set и фактически измеренный успешный restore drill.

`npm run ops:readiness` — только offline-план: читает repository manifest и печатает блокировки. Команда не создаёт Nest context, не читает credentials, не подключается к БД, не запускает restore/workers/browser.
