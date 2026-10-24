# Правила backend

Сначала применяются локальные правила, `docs/MEAL_PLANNER_MASTER_v3.md`, OpenAPI и `docs/TESTs.md`.

- Следовать существующим NestJS/Fastify/Kysely модулям и границам слоёв.
- Не менять публичный контракт, миграции или grants без явного согласования и проверки всех потребителей.
- Проверять authentication, grants, scope, tariff/capability и consent перед каждым эффектом.
- Для конкурентных команд сохранять транзакционность, CAS/version checks и идемпотентность.
- Неизвестный исход внешнего вызова не является успехом или отказом; сохранять состояние для reconciliation.
- Платежи, AI, почта, push, storage и scanner работают fail closed.
- Не логировать секреты, токены, специальные категории данных и provider payloads.
- Изменение endpoint/OpenAPI синхронизировать с generated types, frontend/admin, автоматическими тестами и `docs/TESTs.md`.
- После изменения повысить patch-версию backend, обновить lock и `version-list.md`.
