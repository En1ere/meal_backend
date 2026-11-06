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

`ai-task-policy-v3` — текущая минимальная матрица:

| Минимум                          | Задачи                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free + доступный AI balance      | `culinary_question`, `substitution`, `storage_advice`, `ingredient_extraction`, `product_classification`, `recipe_from_stock`, `personal_recommendation`, `beverage_pairing`, `recipe_adaptation`, `registry_analysis`, `review_summary` |
| Plus                             | всё Free + `shopping_list_generation`, `meal_plan_generation`, `event_menu`                                                                                                                                                              |
| Pro                              | всё Plus + `nutrition_calculation`, `portion_cost_calculation`                                                                                                                                                                           |
| Disabled до отдельного контракта | `seasonal_analysis`, `document_analysis`                                                                                                                                                                                                 |

Purchased, transferred, trial, family-reserve и administrative-compensation buckets не изменяют эту матрицу. Pro может использовать полный разрешённый контекст; Plus и Free получают только источники своих доменов.

Следующая версия каталога может вводить modes внутри task code, например `shopping.personal`, `shopping.family` и `shopping.budget_optimized`. Mode обязан иметь собственные required capabilities/sources/output schema; автоматическое молчаливое повышение режима запрещено.

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
- Transport timeout, connection reset и provider acceptance без подтверждённого response становятся `unknown`, а не `failed`/`released`.
- Автоматический retry допустим только когда доказано, что provider не принял запрос. Иначе работает reconciliation/readback.
- Cancel после provider completion возвращает canonical state и `cancel_too_late`, но не маскирует completed result.

## 6. Provider profile

Launch profile:

```json
{
    "version": "openai-gpt-6-luna-standard-2026-11-07",
    "provider": "openai",
    "transport": "responses",
    "model": "gpt-6-luna",
    "reasoningEffort": "low",
    "background": true,
    "store": false
}
```

`gpt-6.1-sol` может быть отдельным disabled-by-default evaluation profile для тяжёлых задач. Переключение разрешается только после eval по одинаковым fixtures и acceptance criteria: correctness, safety, schema success, latency, input/output/reasoning tokens, provider cost и cost per successful task.

Профиль фиксирует Standard pricing snapshot: Luna `$0.10` за 1M input tokens и `$0.50` за 1M output tokens. При текущих bounded token budgets консервативная верхняя оценка одной задачи классов 1–5 равна соответственно `$0.00155000`, `$0.00310000`, `$0.00570000`, `$0.00830000`, `$0.01140000`. Reasoning tokens входят в provider `output_tokens` и не прибавляются второй раз.

Worker запускается только при явном положительном `AI_MONTHLY_BUDGET_USD`. Перед новым provider submit он под транзакционным advisory lock суммирует фактическую либо ещё удерживаемую оценочную стоимость UTC-месяца. Превышение лимита даёт `provider_budget_exhausted`, не вызывает provider и освобождает пользовательский резерв. Pending/unknown сохраняют консервативную оценку; terminal response заменяет её фактической стоимостью. Несовпадение model/profile также fail closed до внешнего вызова.

На operation/attempt сохраняются provider profile version, requested/actual model, OpenAI request id, timestamps, HTTP/provider outcome, token usage, service tier и estimated/actual cost. Prompt/result в operational logs запрещены.

API key хранится в root-owned Docker secret file. User/admin APIs могут показывать только configured/profile/readiness, но никогда secret, полный endpoint credential или raw provider error.

## 7. Structured Outputs

Каждый task code/mode владеет JSON Schema и версией результата. Общие envelopes не подменяют доменные типы.

- recipe: title, servings, ingredients, steps, warnings, source rationale;
- shopping: normalized items, quantity/unit, source reference, unresolved rows;
- meal plan: bounded days/slots/recipe references, constraints and warnings;
- nutrition: deterministic server-calculated numbers; AI может объяснять или сопоставлять, но не является источником арифметики;
- finance/cost: deterministic server values, currency and missing-price evidence;
- extraction/classification: candidates with confidence and explicit `requiresReview=true`.

Refusal и schema failure — отдельные terminal categories. Некорректный JSON никогда не преобразуется в domain mutation эвристикой.

## 8. Safety

До provider call:

- auth, sanction, tariff/capability, balance, rate limit and consent;
- prompt/topic bounds;
- trusted instructions separated from untrusted content;
- owned references and exact scope;
- applicable moderation decision.

После provider call:

- explicit refusal handling;
- strict schema validation;
- dangerous food/allergen/medical claims warning policy;
- output moderation where applicable;
- no secret/internal instruction leakage.

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
```

Без prompt/result/secret он агрегирует:

1. provider/profile/policy readiness;
2. tariff × task availability;
3. consent/context readiness;
4. usage/tokens/cost/budget and stop-loss;
5. queued/running/unknown/reconciliation counts and age;
6. safety/retention/kill-switch state.

Дальнейшие mutations (`reconcile`, policy edit, kill switch) требуют allowlisted action, permission, MFA, preview, CAS/version, stable idempotency key, execute, audit and authoritative readback. Generic arbitrary retry запрещён.

## 11. Совместимая миграция

1. Task entitlement policy and account-scoped legacy capabilities.
2. Versioned context/source registry and structured result schemas.
3. Additive async operations/readback and schema v37 durable queue while legacy routes remain. **Реализовано.**
4. Frontend typed adapter, stable attempts, queued/running UI and bounded polling/SSE fallback. **Реализованы canonical initial/continuation mutations, owner-scoped readback, bounded polling и явные queued/running/unknown/terminal состояния. SSE остаётся необязательной будущей оптимизацией и не является условием корректности.**
5. Read-only admin control plane. **Реализован агрегированный schema v3 без prompt/context/result и персональных данных: выбранный provider profile, явный месячный budget, actual/held/remaining cost, utilization и stop-loss state доступны оператору.**
6. Reconciliation worker, retention worker, provider telemetry and stop-loss. **Lease-expiry → unknown/reconciliation-hold, provider cost evidence и fail-closed месячный stop-loss реализованы. Конкретная сумма остаётся обязательным внешним owner input; retention deletion и операторское reconcile-действие остаются fail-closed до утверждения policy.**
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
