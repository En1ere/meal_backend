# AI worker: настройка и эксплуатация

> Реализационное состояние на 12 ноября 2026 года: основной runbook ниже описывает существующий выключенный OpenAI/Luna legacy baseline. Provider-neutral port, schema-v41 store и internal `culinary_question/answer`/`substitution/explain`/`storage_advice/explain` simulator paths реализованы, но Yandex adapter не подключён к worker/task routes. Команды legacy-раздела нельзя использовать для условной активации Yandex.

AI-выполнение изолировано от HTTP и общего scheduler. Первичный `POST /api/v1/ai/operations` и continuation `POST /api/v1/ai/tasks/{id}/operations` атомарно проверяют доступ, резервируют действия при необходимости и возвращают `202`; отдельный контейнер `ai-worker` повторно проверяет доступ непосредственно перед OpenAI-вызовом, отправляет Background Response и обновляет canonical readback.

## Подготовленный Yandex adapter — не активирован

Adapter принимает только полный fail-closed набор: secret-file `YANDEX_AI_API_KEY_FILE`, точный endpoint `https://ai.api.cloud.yandex.net/v1/`, folder/service-account identity, фиксированные economy/balanced profile versions, положительный RUB budget, подтверждённый sandbox evidence для `store:false` readback и explicit enable. Key-файл без остальных полей даёт `unconfigured`; полный набор с false enable — `disabled`.

Он всегда отправляет `background:true`, `store:false`, `conversation:null`, strict JSON schema и фиксированный model URI. Transport/5xx/missing ID нормализуется в `unknown_without_identity` без повторного submit; после ID разрешён только GET. Schema v41 уже хранит one-submit/readback evidence и безопасно reconciles истёкшие claims без provider-вызова. До отдельного sandbox spike и task-specific economy/eval gates adapter не добавляется в Compose, не получает production key и не обслуживает public model route.

Первый economy slice использует тот же port только через `AiProviderSimulator`. Safe culinary request ограничен вопросом и 500 output tokens; unsafe boundary завершается на backend. Это внутренний acceptance path без controller, worker registration, Compose service или production egress.

Public activation gate также остаётся закрытым: production Compose фиксирует `AI_V2_CULINARY_PUBLIC_ENABLED=false`. Даже при enable требуются exact Yandex runtime/profile, versioned sandbox readback, eval, legal/region и rollback evidence и положительный RUB budget; simulator или один key readiness не дают.

## Секреты и настройки

Секреты не помещаются в `deploy.env` и Git:

- `/etc/meal-planner/secrets/ai-api-token` — OpenAI API key, `root:meal-secrets`, `0640`, одна непустая строка;
- `/etc/meal-planner/secrets/ai-worker-runtime-database-password` — создаётся provision-скриптом;
- `/etc/meal-planner/secrets/ai-worker-database-url` — создаётся provision-скриптом и содержит отдельный login с `SET ROLE meal_ai_worker`.

Non-secret настройки в `/etc/meal-planner/deploy.env`:

```sh
AI_WORKER_ENABLED=true
AI_API_BASE_URL=https://api.openai.com/v1/
AI_MODEL=gpt-6-luna
AI_PROVIDER_PROFILE_VERSION=openai-gpt-6-luna-standard-2026-11-07
AI_MONTHLY_BUDGET_USD=<согласованный положительный лимит>
AI_WORKER_OWNER_ID=ai-worker-primary
AI_WORKER_BATCH_SIZE=5
AI_WORKER_POLL_MS=2000
AI_WORKER_PROVIDER_POLL_MS=2000
AI_WORKER_LEASE_SECONDS=180
```

`AI_API_BASE_URL` обязан быть HTTPS URL без credentials/query/fragment. Token передаётся контейнеру только как Docker secret file. Ни admin API, ни logs, ни attempt evidence не содержат token, prompt, personal context, полного provider response или raw error. Model обязан точно совпадать с versioned profile. Пустой, нулевой или отсутствующий месячный бюджет не включает worker: значение не имеет небезопасного default и согласуется владельцем отдельно.

Текущий Luna Standard profile использует pricing snapshot `$0.10 / 1M input` и `$0.50 / 1M output`. Перед каждым новым submit worker сериализует budget check, учитывает actual cost завершённых запросов и conservative estimate pending/unknown. Лимит считается по UTC calendar month. При исчерпании лимита provider не вызывается, пользовательский AI-резерв освобождается, а операция получает безопасную категорию `provider_error` с внутренним кодом `provider_budget_exhausted`.

Админка читает те же данные через schema v3 AI control plane: профиль и модель, configured/readiness, месячный лимит, actual cost, conservative held cost, остаток, utilization и `unconfigured/disabled/ready/exhausted`. Это read-only aggregate без API key, endpoint credentials, prompt, context, result и provider request identity.

## Активация

1. Создать token-файл с указанными owner/mode; не печатать значение в shell history.
2. Добавить non-secret настройки и `AI_WORKER_ENABLED=true` в root-owned `deploy.env`.
3. Выполнить обычный backend rollout. Он применит schema v41, вызовет `provision-ai-worker-runtime.sh`, поднимет legacy `ai-worker` и дождётся healthcheck. Этот шаг сам по себе не подключает Yandex adapter.
4. Проверить `docker compose ... ps ai-worker`, отсутствие host ports и сети `meal-db, meal-egress`.
5. Выполнить первичный и continuation запросы: каждый POST должен дать `202/queued`; polling — `queued → running → succeeded`; платный интервал меняет баланс `reserved → captured`, включённое уточнение сохраняет `financialState=none`.

## Обязательные failure-проверки

- Повтор того же idempotency key и payload возвращает ту же операцию; другой payload — `409`.
- Отзыв тарифа, AI consent, special-category consent или sanction до dispatch даёт terminal failure без provider call и освобождает резерв.
- Connection reset, timeout, `5xx`, неоднозначный `404` readback или падение процесса после dispatch дают `unknown/reconciliation_hold`, а не автоматический refund.
- Подтверждённый provider failure освобождает резерв ровно один раз.
- Исчерпанный budget и несовпадение model/profile не создают provider request, имеют нулевую actual cost и освобождают резерв.
- Подтверждённая ошибка включённого уточнения возвращает использованный clarification slot, не создаёт ledger release и оставляет исходную беседу доступной.
- Истёкший lease переводится в `unknown`; устаревший worker не может записать результат из-за lease-token fencing.
- `meal_app` не имеет INSERT на `ai_operation_attempts` и UPDATE на lease columns; `meal_ai_worker` не получает password/MFA/session/admin данные.

## Отключение и ротация

Для fail-closed отключения установить `AI_WORKER_ENABLED=false`, выполнить проверенный Compose reconcile и убедиться, что контейнер отсутствует. Новые canonical операции нельзя публиковать клиенту, пока worker выключен; уже зарезервированные операции остаются видимыми и требуют операторского reconciliation, не массового refund.

Для ротации API key атомарно заменить token-файл с теми же owner/mode и пересоздать только `ai-worker`. Старый ключ отозвать после успешного healthcheck и контрольного запроса. Для ротации DB password удалить только отдельные AI runtime password/URL по change ticket и повторно запустить provision; application database secret не менять.
