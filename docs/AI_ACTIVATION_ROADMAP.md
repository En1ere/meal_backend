# AI: план решений и подготовки к подключению provider key

Статус на 10 ноября 2026 года: все девять блоков согласованы владельцем; policy/contracts, frozen persistence, первый cost-0 backend executor и его public v2 boundary реализованы совместимыми срезами. Документ не разрешает provider call, не содержит секретов и не означает, что целевой Yandex adapter уже реализован.

## 0. Зафиксированные owner decisions

- Политики следующего среза: `ai-task-policy-v4`, `ai-routing-policy-v1`, `ai-price-policy-v1`, `ai-context-policy-v2`, `ai-result-contract-v2`, `ai-cache-policy-v1`, `ai-safety-policy-v1`.
- Всё вычислимое, поисковое и статистическое выполняется backend/SQL. Модель используется только для минимального языкового анализа/синтеза.
- Маршруты: `backend`, `economy`, `balanced`, `disabled`. Один task/mode имеет одинаковый model profile на всех тарифах; автоматические escalation, fallback и повторный submit запрещены на всех слоях.
- Free-рекомендации, shopping lists, nutrition/cost calculation и общие подборки не вызывают AI. Meal plan/event выбирают только из backend shortlist; доменные расчёты и применение результата остаются на backend.
- Предварительный provider — Yandex AI Studio: Alice AI LLM Flash для economy и YandexGPT Pro 5.1 для balanced. Это решение условно до закрытия provider logging/retention, region/legal, readback, least-privilege и pricing-snapshot gates.
- Shared cache разрешён только для allowlisted публичных versioned artifacts. Произвольный semantic cache пользовательских запросов запрещён; personal/family exact cache изолирован scope и повторно проверяет entitlement/consent.
- Цены и квоты controlled launch: Free 0/0; Plus 499 ₽/месяц или 4 899 ₽/год и 20 действий; Pro 999 ₽/месяц или 9 799 ₽/год и 60 действий; trial 7 дней/5 действий; пакет 299 ₽/20 несгораемых действий, не более трёх покупок за 30 дней и 60 неиспользованных действий.
- Provider ceilings: economy 1 ₽, recipe generation/adaptation 6 ₽, event menu 7 ₽, meal plan 12 ₽ с двумя уточнениями. Превышение блокирует вызов до reserve. `seasonal_analysis`, `document_analysis`, `meal_plan_backend_optimizer`, `beverage_alcohol_mode` остаются read-only deferred backlog без возможности включения.

Provider-neutral adapter и reconciliation contract согласованы: submit возвращает accepted/rejected/`unknown_without_identity`; повтор submit запрещён; после получения provider ID разрешён только readback; пользовательский резерв и provider budget hold учитываются независимо; admin не может вручную выставить success. Обязательный spike должен отдельно доказать background retrieve при `store:false`: документированный `x-client-request-id` является correlation id для диагностики, но не гарантией идемпотентного create. Если доказательства нет, нельзя молча включать `store:true` или повторять submit. Следующий реализационный срез — provider-neutral port и выключенный Yandex adapter с fail-closed readiness.

## 1. Что уже готово

- Версионированный каталог из 18 task codes и серверная проверка effective Free/Plus/Pro entitlement.
- Минимизированные task-specific context manifests, consent checks и строгий structured result.
- Canonical `202` initial/continuation, owner-scoped polling, durable queue, lease/fencing и отдельный least-privilege AI worker.
- Независимые lifecycle/financial states, conservative cost reservation, monthly stop-loss и read-only admin control plane.
- Offline `ai-model-eval-v1`, provider simulator/failure tests и 30-дневное удаление AI content с legal-hold исключением.
- Docker/secret-file boundary, disable switch, observability и deployment runbook.
- `ai-task-policy-v4`, minimal v2 contracts, schema v39/v40 frozen identity и zero-cost backend persistence.
- Public `/api/v1/ai/v2/preview|run|operations/{id}` разрешён только для готового `shopping_list_generation/from_meal_plan`; model routes остаются закрыты.

Текущий OpenAI Responses + `gpt-6-luna`/low profile является проверенным выключенным техническим baseline. Целевой выбор Yandex оформлен выше, но замена runtime ещё не реализована и не активирована.

## 2. Решения, которые принимаем последовательно

### A. Продуктовые сценарии и тарифы

Для каждого task code утвердить:

1. пользовательскую задачу и ожидаемый результат;
2. доступные тарифы Free/Plus/Pro;
3. обязательные доменные capabilities и причины блокировки;
4. разрешённые personal/family источники данных;
5. стоимость в AI-действиях, число бесплатных уточнений и границу нового платного интервала;
6. дневные/месячные ограничения, package credits и поведение после downgrade;
7. разрешённое действие после ответа: только preview либо отдельная подтверждаемая доменная команда.

Баланс AI не повышает тариф. Если функция домена отсутствует в текущем тарифе, связанная AI-задача также недоступна. `seasonal_analysis` и `document_analysis` остаются fail-closed до появления достоверных source contracts.

Артефакт: утверждённая tariff/task/context matrix с версией и датой действия.

### B. Провайдер

Сравнить кандидатов по одинаковой матрице:

- юридическая доступность и допустимый регион обработки;
- обучение на API-данных, retention, zero-data-retention/data-controls и DPA;
- Responses/background execution, structured output, retrieve/readback и стабильная request identity;
- модели, context/output limits, rate limits и гарантии совместимости;
- input/output/reasoning/cache pricing и валюта расчёта;
- timeout, confirmed rejection, unknown outcome и provider incident semantics;
- SLA/status page, экспорт usage/cost evidence и процедура rotation/revocation ключа.

Артефакт: provider decision record с выбранным основным provider, допустимым fallback или явным запретом fallback.

### C. Модели и routing

Для каждого класса задач утвердить:

- точный versioned model/profile id;
- reasoning effort, максимальные input/output tokens и deadline;
- допустимые multimodal inputs;
- критерии перехода на более дорогую модель;
- fallback-модель и условия её использования либо запрет fallback;
- поведение при deprecation/model drift.

Luna и Sol сравниваются только на одном `ai-model-eval-v1`; автоматическое повышение на более дорогую модель запрещено. Смена profile требует нового pricing snapshot, eval evidence, owner approval и deploy/readback.

Артефакт: versioned routing table без секретов и скрытых task branches.

### D. Качество и evaluation

Утвердить по task class:

- обязательные correctness/schema/safety thresholds;
- аллергенные, пищевые, медицинские и prompt-injection негативные сценарии;
- допустимые p50/p95 latency и token/cost ceiling;
- human-review rubric и минимальный размер выборки;
- запрет выдавать отсутствующие nutrition/cost/source данные за факты.

Артефакт: неизменный eval manifest и promotion gate. Provider success не принимается по mock evidence.

### E. Данные, согласия и retention

Для каждого источника определить:

- категорию данных, цель и минимально необходимый набор полей;
- personal/family scope и тарифную доступность;
- обязательное согласие и реакцию на его отзыв до dispatch;
- регион/передачу subprocessors;
- provider storage/training setting;
- product retention, legal hold и доступность continuation после purge.

Нельзя отправлять provider payload, prompt, context, result или request identity в browser telemetry, обычные логи и admin UI.

Артефакт: утверждённая data-flow/consent/retention matrix.

### F. Тарифная экономика и stop-loss

Утвердить:

- pricing snapshot выбранных моделей;
- conservative ceiling каждого task class;
- пользовательские и семейные AI allowances/packages;
- положительный месячный provider budget;
- warning/critical thresholds и получателя alerts;
- поведение при исчерпании бюджета, изменении цены и рассинхронизации profile;
- contribution-margin target для каждого тарифа.

Нулевой или отсутствующий budget означает disabled, а не unlimited. Pending/unknown удерживают conservative estimate до подтверждённого terminal outcome.

Артефакт: versioned pricing/budget policy и admin-safe projection.

### G. Safety и модерация — согласовано как target

Утверждено в `ai-safety-policy-v1` и `ai-eval-policy-v2`:

- backend-owned allergen, food-safety, nutrition/cost и medical boundaries нельзя переопределить моделью;
- неизвестный состав при заявленной аллергии блокирует применение как `insufficient_safety_data`;
- medical-risk сценарии ограничиваются общей информацией и recovery к специалисту;
- critical result не показывается частично, action освобождается, provider cost учитывается отдельно;
- strict schema/hard constraints/critical safety требуют 100%, economy correctness ≥95%, balanced ≥90%, p95 latency 45/120 секунд;
- минимум 20 representative fixtures на AI-mode, 100 adversarial/safety fixtures и три прогона каждого critical fixture;
- feedback apply/reject/rating/reason/edit volume сохраняется локально для будущего backend planner.

Артефакт: safety policy, тесты и user-facing recovery states.

### H. Unknown outcome и reconciliation — согласовано как target

Утверждено:

1. canonical provider status читается только по уже сохранённому `providerResponseId`;
2. timeout до получения ID создаёт `unknown_without_identity`, освобождает user reservation и сохраняет conservative provider budget hold;
3. timeout после получения ID создаёт `unknown/reconciliation_hold`; разрешён повтор GET, но не submit;
4. operator release требует permission/MFA/preview/confirm/execute/audit/readback;
5. ручные `succeeded`, result override и retry submit запрещены;
6. при согласованном `store:true` terminal result сначала сохраняется локально, затем provider response удаляется с отдельным retention alert на неизвестный DELETE.

Для реализации потребуются additive backend/admin contracts, capability/grant, preview-confirm flow, CAS/idempotency tests и ручной test-case.

Артефакт: отдельный ADR и утверждённая state transition matrix.

### I. Управление через админку — согласовано как target

До подключения key основной control plane безопасно показывает:

- выбранные provider/model/routing/pricing policy versions;
- configured/disabled/ready/exhausted без значения secret;
- budget, actual/held cost и utilization;
- queue/running/unknown ages и worker health;
- retention/eval status и явные blockers.

`ai-admin-control-policy-v1` разрешает только emergency disable, gated enable, force readback, evidence-based user-reservation release, monthly budget update и safety-incident acknowledgement. Все действия проходят permission → MFA → reason → preview → CAS/idempotency → confirm → execute → audit/readback. Deferred backlog, arbitrary policy JSON, manual success/result override и provider retry недоступны. Secret вводится и ротируется вне browser UI.

Отдельная `/admin/ai/history` доступна только с `ai.history.read`, MFA и обязательной причиной/case reference. Она показывает локальные user/assistant messages конкретного найденного пользователя в пределах retention, но не system prompt, internal context, provider payload/request id, secret или hidden detectors. Каждый просмотр аудируется; bulk feed/export в первой версии отсутствует. Privacy/legal disclosure является activation gate.

Артефакт: утверждённый settings/action registry, history access policy и operator runbook.

## 3. Техническая подготовка до API key

После согласования A–I выполнить без реального ключа:

1. адаптировать provider-neutral port и выбранный adapter без утечки provider DTO в публичные контракты;
2. зафиксировать model/routing/pricing/data/safety profiles и миграцию только при необходимости durable evidence;
3. закрыть reconciliation contract и admin flow согласно принятому ADR;
4. подготовить exact env/secret-file names, Docker overlay, least-privilege role и egress allowlist;
5. обеспечить disabled/unconfigured startup, key rotation и аварийное отключение;
6. пройти unit/contract/integration/provider-simulator tests: success, rejection, 429, 5xx, timeout, reset, unknown, polling, crash, replay, quota race и budget exhaustion;
7. прогнать offline eval, architecture/security/secret scans, builds и browser manual cases;
8. обновить OpenAPI/generated clients, тест-кейсы, deployment/rollback/incident runbooks и admin registry;
9. развернуть fail-closed release без key и подтвердить, что provider call невозможен.

## 4. Definition of ready: остаётся только подключить key

Структура считается готовой к ключу, когда одновременно выполнено:

- все решения A–I имеют owner approval и versioned artifacts;
- выбранный adapter, exact model profiles и routing полностью реализованы;
- тарифы, allowances, pricing и положительный monthly budget заданы без секретов;
- reconciliation и admin operator flow реализованы и протестированы;
- provider simulator и offline eval проходят принятые thresholds;
- production Compose содержит выключенный AI worker и фиксированный абсолютный secret-file path;
- GitHub Environment/VPS secret inventory содержит имя секрета, владельца, права, rotation/revoke и recovery procedure, но не значение;
- deployment, disable, rollback, incident и budget-alert runbooks проверены;
- admin показывает `unconfigured`, не раскрывает secret и не допускает ложного success.

После этого единственный отсутствующий конфигурационный материал — значение provider API key. Его подключение всё равно требует контролируемого activation run: записать key в secret store, включить worker с положительным budget, выполнить ограниченный synthetic eval/smoke, проверить usage/cost/readback/unknown handling и сохранить provider evidence. Это не новая разработка и не новое продуктовое решение.

## 5. Остальные глобальные работы после AI

1. Транзакционная почта: provider, sender domain, SPF/DKIM/DMARC, secret, bounce/complaint suppression и real inbox evidence.
2. Media publication: malware scanner или утверждённая non-public policy, capacity, MIME/size/retention и cleanup/legal-hold решения.
3. Off-host backup и alerts: внешний encrypted target, key custody, RPO/RTO, isolated restore, metric/error/uptime sink и получатели.
4. Legal/custom domain: реальные реквизиты, юридическое утверждение, subprocessors/regions, DNS/certificates и origin cutover.
5. Платежи/ККТ: юрлицо, acquiring/receipt providers, merchant/webhook secrets, sandbox/live acceptance и reconciliation.
6. Финальная приёмка: реальные provider cycles, physical iOS/Android, screen reader, external TLS/header probe, capacity/load и owner manual test pack.

До закрытия каждого пункта соответствующая функция остаётся fail-closed и не имитирует внешний успех.
