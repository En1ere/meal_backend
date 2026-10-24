# Meal Planner backend

NestJS/Fastify API с PostgreSQL/Kysely, OpenAPI, серверными сессиями, пользовательским и staff MFA, фоновыми операциями и fail-closed внешними адаптерами. Текущая версия берётся из `package.json`.

## Запуск и проверки

```powershell
npm install
npm run build
npm run start
npm run check
npm run openapi
```

Миграции сначала планируются командой `npm run db:plan`; применение `npm run db:migrate` требует явно выбранного окружения, backup и отдельного разрешения. Порядок переноса — `docs/transfer-migrations.md`, backup/restore — `docs/backup-recovery.md`.

## Инварианты

- API возвращает безопасные ошибки без секретов и внутренних stack traces.
- Роли, grants, scope, тариф и consent проверяются на сервере непосредственно перед эффектом.
- Команды с повтором используют стабильный idempotency key; unknown outcome требует readback/reconciliation.
- Платёжный provider, AI, email/push, storage и scanner не заменяются фиктивным успехом.
- Вложения и OCR ограничены размером/типом, проходят безопасную обработку и ручное подтверждение; provenance runtime — `resources/ocr/README.md`.
- Телеметрия не содержит токены, содержимое документов и чувствительные payloads; правила — `docs/telemetry.md`.
- Worker topology и maintenance-команды описаны в `docs/operational-maintenance.md`.

Полная ручная и API-приёмка находится в `docs/TESTs.md`. Юридический пакет — `docs/legal/`; он остаётся `draft_blocked` до заполнения реальных данных и утверждения.

## Самостоятельный репозиторий

Node.js 24 (см. `.node-version`), npm 11. Установите зависимости `npm ci`, скопируйте `.env.example` в `.env`, задайте независимые `SECURITY_KEY` и `MFA_ENCRYPTION_KEY` (по 32 случайных байта base64) и `DATABASE_URL` роли `meal_app`. Затем `npm run build` и `npm start`. API: `http://127.0.0.1:3001/api/v1`, liveness: `/health/live`, readiness: `/health/ready`. Без БД процесс запускается, readiness возвращает 503.

Клиент живёт в независимом `meal_frontend`, админка — в независимом `meal_admin`; оба приложения обращаются через свой `/api` proxy к `BACKEND_ORIGIN=http://127.0.0.1:3001`. По умолчанию разрешены origins `http://localhost:3000` и `http://localhost:3002`. Миграции и seed при старте API не выполняются. После чистых миграций владелец явно применяет `database/reference-data.sql`: только 7 единиц измерения и 3 тарифных продукта, без аккаунтов и подписок. Платежи, почта, AI и прочие внешние провайдеры остаются fail closed.

`npm run legal:readiness -- --evidence <file> --release <file>` принимает отдельный JSON с версиями `root`, `front`, `admin` проверяемых frontend/admin releases, поскольку соседний репозиторий не является локальной зависимостью backend. Версии backend/OpenAPI читаются локально. Без доказательств юридический выпуск остаётся заблокированным.

Изолированный PostgreSQL acceptance: `npm run test:postgres:isolated -- -PgBin <PostgreSQL18-bin> -Iterations 1`. Временная БД и отчёты размещаются только в `D:\AITemp\meal-backend-postgres-acceptance`; тест не подключается к серверной БД.

## Три независимых приложения

| Репозиторий     | Локальный адрес         | Назначение                                |
| --------------- | ----------------------- | ----------------------------------------- |
| `meal_backend`  | `http://127.0.0.1:3001` | NestJS API и подключение PostgreSQL       |
| `meal_frontend` | `http://localhost:3000` | Next.js клиент с собственным `/api` proxy |
| `meal_admin`    | `http://localhost:3002` | Vite админка с собственным `/api` proxy   |

В backend задаются `FRONTEND_ORIGIN=http://localhost:3000` и `ADMIN_FRONTEND_ORIGIN=http://localhost:3002`. В каждом frontend отдельно задаётся `BACKEND_ORIGIN=http://127.0.0.1:3001`; для админки включается `VITE_API_MODE=real`. Origins должны совпадать с адресами браузера, включая имя host и порт. HTTP-контракты не меняются при выделении админки; перенос cookies/CSRF между клиентом и admin namespace не допускается.

Для локальной работы с существующей тестовой БД сначала откройте отдельный SSH tunnel `ssh -N -L 15432:127.0.0.1:5432 alex@91.201.42.153`. Затем в backend выполните `npm ci`, `npm run build`, `npm start` с локальным ignored `.env` и проверьте `/health/ready` (200 означает готовность БД). Клиент и админку запускайте независимо по их README. Остановка туннеля делает БД недоступной локальному API; повторное применение миграций или reference data для обычного запуска не нужно. База не публикует порт в интернет.
