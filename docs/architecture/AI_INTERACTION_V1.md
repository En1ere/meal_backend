# AI interaction v1

Статус: согласованная целевая спецификация. Реализация выполняется совместимыми срезами; legacy `preview/run/tasks` удаляется только после миграции frontend и production evidence.

## 1. Инварианты

1. AI не открывает возможности старшего тарифа. Баланс отвечает только за оплату уже разрешённого сценария.
2. Backend — единственный источник истины для task availability, стоимости, контекста, consent, состояния операции и списания.
3. Любой personal context формируется сервером как ограниченный immutable snapshot. Клиент выбирает только допустимые источники из серверного предложения.
4. Prompt, OCR, документ, ссылка и результат модели являются недоверенными данными, а не инструкциями или domain command.
5. Результат модели не изменяет домен напрямую. Сначала strict structured result, затем deterministic validation/preview, затем отдельная подтверждённая доменная команда.
6. Технический retry не оплачивается и не создаёт новую работу. Неопределённый исход сначала сверяется по canonical readback.
7. Локальные prompts, context snapshots, messages и results хранятся не более 30 дней, если нет отдельного legal hold. Archive не считается удалением.

## 2. Каталог задач и тарифы

`ai-task-policy-v4` — утверждённая целевая матрица. Она вводит обязательный `mode` и четыре класса исполнения: `backend`, `economy`, `balanced`, `disabled`.

| Минимум                          | Задачи                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free + доступный AI balance      | `culinary_question`, `substitution`, `storage_advice`, `ingredient_extraction`, `product_classification`, `recipe_from_stock`, `beverage_pairing`, `recipe_adaptation`, `registry_analysis`; `personal_recommendation/weekly` и публичный `review_summary` выполняются backend/artifact и не требуют AI balance |
| Plus                             | всё Free + `shopping_list_generation`, `meal_plan_generation`, `event_menu`                                                                                                                                                                                                                                     |
| Pro                              | всё Plus + `nutrition_calculation`, `portion_cost_calculation`                                                                                                                                                                                                                                                  |
| Disabled до отдельного контракта | `seasonal_analysis`, `document_analysis`                                                                                                                                                                                                                                                                        |

Purchased, transferred, trial, family-reserve и administrative-compensation buckets не изменяют эту матрицу. Pro может использовать полный разрешённый контекст; Plus и Free получают только источники своих доменов.

Mode владеет required capabilities/sources, route, cost, limits и output schema. Backend/SQL обязателен для поиска, статистики, арифметики, подборок и проверок. Тариф меняет entitlement, доступный контекст, квоту и queue priority, но не model profile для одного task/mode. Автоматическое повышение route/model запрещено на frontend, backend, worker и provider adapter.

## 3. Контекст

Каждая source policy содержит:

```ts
type AiContextSourcePolicy = {
    kind: AiContextSourceKind;
    required: boolean;
    requiredCapability: string | null;
    consentKind: string | null;
    maxItems: number;
    maxBytes: number;
    freshnessSeconds: number | null;
};
```

Разрешённые категории:

- `user_prompt` — всегда;
- `personal_profile`, `preferences`, `dietary_restrictions`;
- `personal_inventory`, `family_inventory`;
- `owned_recipe`, `public_recipe_catalog`;
- `meal_plan`, `shopping_list`;
- `nutrition_profile`, `nutrition_targets`, `diary_summary` — только Pro;
- `price_observations`, `finance_summary` — только Pro;
- `bounded_public_reviews`;
- `owned_document_extract` — только после отдельного media/OCR контракта;
- `seasonality_dataset` — только после появления версионированного источника.

Фактический manifest сохраняется до резервирования:

```ts
type AiContextManifest = {
    version: 'ai-context-v1';
    consentEvidence: Array<{ kind: string; documentVersion: string; acceptedAt: string }>;
    entitlement: { plan: 'free' | 'plus' | 'pro'; source: string; checkedAt: string };
    sources: Array<{
        kind: AiContextSourceKind;
        itemCount: number;
        bytes: number;
        truncated: boolean;
        snapshotHash: string;
        capturedAt: string;
    }>;
};
```

Raw source content не возвращается в capabilities/admin projection. Пользовательский preview показывает понятные labels, количество, freshness и truncation. Отзыв consent блокирует новый preview/run/continuation, но не переписывает историческое evidence.

## 4. Публичный lifecycle

Целевые endpoints:

```text
GET    /api/v1/ai/catalog
POST   /api/v1/ai/operations/preview
POST   /api/v1/ai/operations
GET    /api/v1/ai/operations/{id}
GET    /api/v1/ai/operations/{id}/events
POST   /api/v1/ai/operations/{id}/cancel
POST   /api/v1/ai/tasks/{id}/operations
```

Оба create-route возвращают `202 Accepted`, canonical operation id и read URL. Continuation использует тот же lifecycle и финансовую модель; включённое уточнение имеет `financialState=none`, новый платный интервал — `reserved`. SSE является ускорением, а не единственным источником состояния; polling readback обязателен как fallback.

Operation states:

```text
accepted -> queued -> running -> succeeded
                         |------> failed
accepted/queued --------> cancelled
running ----------------> unknown -> reconciliation -> succeeded|failed
```

Financial states независимы:

```text
none -> reserved -> captured
                 -> released
                 -> reconciliation_hold -> captured|released
```

`refunded` остаётся legacy projection и не используется как transport/provider state.

Canonical response содержит как минимум:

```ts
type AiOperation = {
    id: string;
    conversationId: string;
    taskType: AiTaskType;
    taskPolicyVersion: string;
    contextManifestVersion: string;
    state: 'accepted' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    financialState: 'none' | 'reserved' | 'captured' | 'released' | 'reconciliation_hold';
    failure: { category: string; retryable: boolean; userMessage: string } | null;
    result: unknown | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    version: number;
};
```

## 5. Idempotency и unknown outcome

- Mutation принимает обязательный UUID idempotency key и server-computed request hash.
- Повтор exact key + exact hash возвращает тот же operation/readback.
- Тот же key с другим hash возвращает `409` без нового reserve или provider call.
- Frontend сохраняет key вместе с fingerprint до подтверждённого terminal/readback. Новый click после timeout не создаёт новый UUID.
- Provider port возвращает ровно один submit outcome: `accepted` с `providerResponseId`, `rejected` с нормализованной категорией либо `unknown_without_identity` с локальным `clientRequestId`. `x-client-request-id` используется только для correlation/support и не доказывает идемпотентность provider create.
- Transport timeout/reset до получения `providerResponseId` становится `unknown_without_identity`. Автоматический повтор submit запрещён. Пользовательский резерв освобождается, потому что доступный пользователю результат отсутствует; консервативная возможная стоимость остаётся в отдельном provider budget hold до reconciliation/invoice evidence.
- После сохранения `providerResponseId` разрешён только canonical GET/readback. Его состояния нормализуются в `queued`, `running`, `succeeded`, `failed`, `cancelled`, `incomplete` или `unknown`. Timeout/readback failure переводит operation в `unknown/reconciliation_hold`, но не создаёт новый submit.
- Lifecycle state, user financial state и provider cost state независимы. Release пользовательской квоты не удаляет provider cost evidence и не превращает неизвестный provider outcome в `failed`.
- Admin не может вручную выставить `succeeded`, подменить result или повторить submit. Разрешённые будущие действия: force readback по существующему ID и подтверждённое освобождение user reservation через permission → MFA → preview → confirm → execute → audit/readback.
- Если contract spike докажет необходимость `store:true`, после terminal GET worker сначала валидирует и транзакционно сохраняет минимальный локальный result/usage, затем вызывает provider DELETE. Повтор DELETE безопасен и не считается повтором генерации; delete failure создаёт retention alert и отдельную cleanup job.
- Cancel после provider completion возвращает canonical state и `cancel_too_late`, но не маскирует completed result.

Минимальный provider-neutral port:

```ts
type ProviderSubmitOutcome =
    | { kind: 'accepted'; providerResponseId: string; clientRequestId: string }
    | { kind: 'rejected'; category: string; retryable: false }
    | { kind: 'unknown_without_identity'; clientRequestId: string };

type ProviderReadOutcome =
    | { kind: 'queued' | 'running' }
    | { kind: 'succeeded'; rawResult: unknown; usage: unknown }
    | { kind: 'failed' | 'cancelled' | 'incomplete'; category: string }
    | { kind: 'unknown' };

interface AiProviderPort {
    submit(request: FrozenProviderRequest): Promise<ProviderSubmitOutcome>;
    read(providerResponseId: string): Promise<ProviderReadOutcome>;
    delete?(providerResponseId: string): Promise<'deleted' | 'already_absent' | 'unknown'>;
}
```

Реализационный статус на 11 ноября 2026 года: neutral types/strict schemas, dispatch guard и независимые user-quota/provider-budget effects реализованы. Schema v41 сохраняет один submit claim, immutable provider ID, normalized read outcomes, conservative RUB hold и CAS/lease fencing; expiry reconciliation не вызывает provider. Internal `culinary_question/answer` и backend-first `substitution/candidates|explain` проходят strict safety/minimal-contract path только через simulator, включая quota capture/release/hold и локальную историю. Изолированный Yandex adapter нормализует HTTP/transport outcomes, не повторяет submit и после accepted допускает только readback, но ещё не подключён к model task routes.

## 6. Provider profiles и routing

Целевые launch-профили:

| Route      | Profile                         | Provider/model                        | Reasoning | Верхний input/output |
| ---------- | ------------------------------- | ------------------------------------- | --------- | -------------------- |
| `economy`  | `yandex-alice-flash-economy-v1` | Yandex AI Studio / Alice AI LLM Flash | minimal   | 24 KB / 1 000 tokens |
| `balanced` | `yandexgpt-5.1-balanced-v1`     | Yandex AI Studio / YandexGPT Pro 5.1  | low       | 48 KB / 2 000 tokens |

Оба профиля целятся в Responses/background, `store:false`, отключённое provider conversation state и не имеют runtime fallback. До реализации требуется provider contract spike: документация Yandex связывает получение response по ID с сохранённым response и не документирует идемпотентный create. Если background readback с `store:false` не подтверждается, activation блокируется до отдельного owner decision между другим transport/provider и ограниченным `store:true` с немедленным `DELETE` после terminal readback. `x-client-request-id` считается только диагностическим correlation id, а не idempotency key. Task-specific limits всегда уже profile ceiling: например meal plan — 32 KB/700 tokens, adaptation — 18 KB/1 200 tokens, `replace_slot` — 4 KB/100 tokens и не более 10 кандидатов. Превышение лимита не исправляется скрытым усечением результата.

OpenAI/Luna остаётся описанием существующего выключенного технического baseline и offline eval candidate, но не целевым коммерческим маршрутом. Production activation Yandex запрещена до подтверждения отключённого provider logging/tracing, корректного background readback, допустимого региона и правовых условий, least-privilege service account и точного versioned pricing snapshot.

Provider cost ceilings: economy — 1 ₽/operation; recipe generation/adaptation — 6 ₽; event menu — 7 ₽; meal plan — 12 ₽ вместе с двумя уточнениями, из них initial не более 9,50 ₽ и каждое уточнение не более 1,25 ₽. Preflight выше ceiling либо неизвестный/устаревший pricing snapshot возвращает `provider_cost_limit_exceeded` до reserve/provider call. Rolling cost guardrails: warning 1 ₽/действие, critical 1,50 ₽/действие; provider budget utilization 70%/90%/100% = warning/critical/stop.

Worker запускается только при явном положительном месячном бюджете в валюте provider. Перед submit он под транзакционным advisory lock суммирует фактическую либо ещё удерживаемую оценочную стоимость периода. Превышение лимита даёт `provider_budget_exhausted`, не вызывает provider и освобождает пользовательский резерв. Pending/unknown сохраняют консервативную оценку; terminal response заменяет её фактической стоимостью. Несовпадение frozen route/profile/model также fail closed до внешнего вызова.

На operation/attempt сохраняются provider profile version, requested/actual model, provider request id, timestamps, HTTP/provider outcome, token usage и estimated/actual cost. Prompt/result в operational logs запрещены.

API key хранится в root-owned Docker secret file. User/admin APIs могут показывать только configured/profile/readiness, но никогда secret, полный endpoint credential или raw provider error.

Fail-closed Yandex configuration использует `YANDEX_AI_API_KEY_FILE`, точный `YANDEX_AI_ENDPOINT=https://ai.api.cloud.yandex.net/v1/`, `YANDEX_AI_FOLDER_ID`, `YANDEX_AI_SERVICE_ACCOUNT_ID`, обе фиксированные profile versions, положительный `YANDEX_AI_MONTHLY_BUDGET_RUB`, `YANDEX_AI_STORE_FALSE_READBACK_VERIFIED=true` и отдельный `YANDEX_AI_ENABLED=true`. Наличие только key-файла оставляет `unconfigured`; полный набор при false enable остаётся `disabled`. До sandbox evidence флаг readback запрещено выставлять в deployment.

## 7. Structured Outputs

Каждый task code/mode владеет JSON Schema и версией результата. Минимальный общий envelope — `{schemaVersion,data,warningCodes}`; task/mode и route уже находятся в operation и не дублируются. Extra fields запрещены, строки и коллекции bounded. После schema validation backend отдельно проверяет owned references, hard constraints и safety.

- recipe generation: только минимальные поля нового рецепта, необходимые для backend preview; метаданные и warning codes добавляет backend;
- shopping: полностью deterministic backend projection, без provider output;
- meal plan/event: только bounded slot-to-candidate indices; recipe ids, порции, продукты, allergens, nutrition и cost восстанавливает и проверяет backend;
- nutrition: deterministic server-calculated numbers; AI может объяснять или сопоставлять, но не является источником арифметики;
- finance/cost: deterministic server values, currency and missing-price evidence;
- extraction/classification: минимальные normalized values либо индекс из backend shortlist; review policy определяет backend.

Refusal и schema failure — отдельные terminal categories. Некорректный JSON никогда не преобразуется в domain mutation эвристикой.

## 8. Safety

`ai-safety-policy-v1` закрепляет backend как единственный источник аллергенов, сроков, температур, КБЖУ, стоимости и структурированных противопоказаний. Модель может объяснить server verdict, но не изменить его, удалить warning, ослабить hard constraint, назначить лечение/препарат/лечебную диету или самостоятельно вычислить индивидуальную медицинскую норму.

До provider call:

- auth, sanction, tariff/capability, balance, rate limit and consent;
- prompt/topic bounds;
- trusted instructions separated from untrusted content;
- owned references and exact scope;
- applicable moderation decision.
- для заявленной аллергии неизвестный состав или непроверяемая замена дают `insufficient_safety_data`; provider call и автоматическое применение блокируются;
- pregnancy, child nutrition, chronic condition и другие health-risk признаки ограничивают ответ общей информацией и recovery к профильному специалисту.

После provider call:

- explicit refusal handling;
- strict schema validation;
- dangerous food/allergen/medical claims warning policy;
- output moderation where applicable;
- no secret/internal instruction leakage.
- server-owned allergen, food-safety, medical and source-rule verdicts повторно проверяются после schema validation;
- critical failure не показывается частично, user action освобождается, а фактическая provider cost учитывается отдельно без fallback.

Нормализованные safety outcomes:

- `safety_rejected` — сценарий нельзя безопасно выполнить;
- `insufficient_safety_data` — недостаточно проверяемых данных;
- `professional_review_required` — запрос выходит в медицинскую область;
- `unsafe_provider_result` — provider output нарушил hard safety policy;
- `source_rule_unavailable` — отсутствует актуальное server rule/source release.

Production safety incident выключает затронутый task/profile fail-closed. Автоматический переход на другой профиль запрещён.

Safety event хранит policy version, category, confidence, evidence hash и operation linkage. Raw content доступен только отдельной минимальной privileged projection, если она будет юридически разрешена.

## 9. Retention

- Product prompt/context/message/result TTL: 30 days from operation terminal time.
- Operational metadata without content may храниться дольше по audit policy.
- `expiresAt` доступен пользователю и admin aggregate.
- Daily retention worker uses bounded batches, lease/fencing, idempotent deletion and observable failures.
- Legal hold блокирует deletion только для exact records и имеет actor/reason/expiry/audit.
- User archive меняет видимость, но не TTL.
- Account deletion owns the stricter lifecycle and must not wait for ordinary 30-day cleanup.

OpenAI request uses `store: false`. According to official OpenAI data controls, API content is not used for model training unless explicitly opted in; default abuse-monitoring logs may be retained up to 30 days. ZDR is a separate organization-level eligibility/configuration and is not assumed.

## 10. Admin control plane

Первый endpoint read-only:

```text
GET /api/v1/admin/ai/control-plane
POST /api/v1/admin/ai/actions/preview
POST /api/v1/admin/ai/actions/{previewId}/confirm
GET /api/v1/admin/ai/actions/{operationId}
GET /api/v1/admin/ai/history/users/{userId}/conversations
GET /api/v1/admin/ai/history/conversations/{conversationId}/messages
```

Основной control plane без prompt/result/secret агрегирует:

1. provider/profile/policy readiness;
2. tariff × task availability;
3. consent/context readiness;
4. usage/tokens/cost/budget and stop-loss;
5. queued/running/unknown/reconciliation counts and age;
6. safety/retention/kill-switch state.

`ai-admin-control-policy-v1` разрешает только закрытый enum действий: аварийные `disable_global|disable_profile|disable_task_mode`, gated `enable_profile|enable_task_mode`, `force_readback`, `release_user_reservation`, `set_monthly_budget` и `acknowledge_safety_incident`. Deferred capabilities так включить нельзя. Любая mutation требует отдельный permission, MFA, reason, preview, CAS/version, stable idempotency key, confirm, execute, before/after audit hash и authoritative readback. Увеличение бюджета требует owner-level permission; повторное включение — свежий eval, provider readiness, положительный budget и отсутствие незакрытого critical safety incident. Generic retry, ручной success/result override и browser secret management запрещены.

Отдельная вкладка `/admin/ai/history` показывает локальную продуктовую историю сообщений конкретного пользователя в пределах действующей retention/legal-hold policy. Это не часть агрегированного control plane и не общий feed. Доступ требует отдельного `ai.history.read`, действующей MFA-сессии, точного user lookup, обязательной purpose/reason или support/moderation case reference; каждое открытие conversation и страницы сообщений создаёт audit event. Первая версия не предоставляет bulk export.

History projection содержит user/assistant messages, task/mode, timestamps, operation status и user-facing warning codes. Она не раскрывает system/developer prompt, internal context snapshot, provider payload/logs, provider request id, secret, hidden safety detector или operational stack. Purged content показывается только как факт удаления; admin view не обходит 30-дневную очистку, account deletion, consent/revocation rules или legal hold. Такой доступ и его цели должны быть отражены в privacy/legal документах до production activation.

## 11. Совместимая миграция

1. Task entitlement policy and account-scoped legacy capabilities.
2. Versioned context/source registry and structured result schemas.
3. Additive async operations/readback and schema v37 durable queue while legacy routes remain. **Реализовано.**
4. Frontend typed adapter, stable attempts, queued/running UI and bounded polling/SSE fallback. **Реализованы canonical initial/continuation mutations, owner-scoped readback, bounded polling и явные queued/running/unknown/terminal состояния. SSE остаётся необязательной будущей оптимизацией и не является условием корректности.**
5. Read-only admin control plane. **Реализован агрегированный schema v3 без prompt/context/result и персональных данных: выбранный provider profile, явный месячный budget, actual/held/remaining cost, utilization и stop-loss state доступны оператору.**
6. Reconciliation worker, retention worker, provider telemetry and stop-loss. **Lease-expiry → unknown/reconciliation-hold, provider cost evidence, fail-closed месячный stop-loss и schema v38 daily AI content retention реализованы. Retention удаляет prompt/context/messages/results после 30 дней, пропускает legal hold и сохраняет операционную/финансовую метаинформацию. Конкретная сумма budget остаётся внешним owner input; операторское reconcile-действие ещё не опубликовано.**
7. Production provider success/eval evidence. **Версионированный offline eval-контур `ai-model-eval-v1` реализован без provider call: одинаковые fixtures, обезличенный evidence и агрегаты correctness/safety/schema/latency/tokens/cost готовы. Реальный Luna/Sol evidence требует ключа и согласованного бюджета.**
8. Remove legacy routes only after client rollout, usage drain and explicit deprecation evidence.

Schema v37 и отдельный `ai-worker` реализуют durable queue: HTTP-транзакция только резервирует действия и возвращает `202`, worker создаёт attempt до внешнего вызова, использует lease/fencing, OpenAI client request id и background readback. Перед dispatch повторно проверяются account/sanction, текущий тариф и согласия. Timeout/reset/неизвестный HTTP/provider outcome переводится в `unknown/reconciliation_hold`; blind reconciliation/refund запрещён. Legacy `preview/run/tasks` сохранены до миграции frontend и production evidence.

## 12. Обязательные тесты

- Free/Plus/Pro × every task; package/grant never elevates plan.
- Consent revoked before preview, between preview/run and before continuation.
- Subscription downgrade/expiry between every lifecycle boundary.
- Same-key replay, changed-payload conflict, transport unknown and provider unknown.
- Reserve/capture/release/reconciliation-hold invariants and crash at every boundary.
- Structured success/refusal/schema failure/safety failure.
- Poll/SSE reconnect, refresh, multiple tabs and cancellation.
- 30-day expiration, archive, legal hold, account deletion and failed cleanup.
- Provider disabled/rate-limited/timeout/overload; budget stop-loss and kill switch.
- No prompt/context/result/secrets in logs, telemetry, admin aggregate or error envelope.
