# AI: план решений и подготовки к подключению provider key

Статус на 7 ноября 2026 года: реализация приостановлена перед внешней активацией. Документ фиксирует оставшиеся решения и артефакты. Он не разрешает provider call, не задаёт бюджет и не содержит секретов.

## 1. Что уже готово

- Версионированный каталог из 18 task codes и серверная проверка effective Free/Plus/Pro entitlement.
- Минимизированные task-specific context manifests, consent checks и строгий structured result.
- Canonical `202` initial/continuation, owner-scoped polling, durable queue, lease/fencing и отдельный least-privilege AI worker.
- Независимые lifecycle/financial states, conservative cost reservation, monthly stop-loss и read-only admin control plane.
- Offline `ai-model-eval-v1`, provider simulator/failure tests и 30-дневное удаление AI content с legal-hold исключением.
- Docker/secret-file boundary, disable switch, observability и deployment runbook.

Текущий OpenAI Responses + `gpt-6-luna`/low profile является проверенным техническим baseline, а не необратимым коммерческим выбором. Его сохранение либо замена должны быть оформлены отдельным решением до внешней активации.

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

### G. Safety и модерация

Утвердить:

- границы пищевой безопасности, аллергенов и медицинских рекомендаций;
- обязательные предупреждения и случаи отказа;
- входную/выходную moderation policy;
- обработку жалоб и апелляций;
- запрет прямых доменных mutations из AI-ответа.

Артефакт: safety policy, тесты и user-facing recovery states.

### H. Unknown outcome и reconciliation — критическое решение

Нужно отдельно согласовать рекомендуемую модель:

1. обычное операторское действие выполняет только provider readback по существующему `provider_request_id`;
2. новый submit с тем же бизнес-намерением не отправляется;
3. ручной `succeeded` запрещён;
4. release возможен только после MFA и подтверждения, что provider не обработал запрос, с причиной, внешним evidence reference, expected version, idempotency и audit;
5. отсутствие достаточного evidence сохраняет `unknown/reconciliation_hold`.

После решения потребуются additive backend/admin contracts, capability/grant, preview-confirm flow, CAS/idempotency tests и ручной test-case.

Артефакт: отдельный ADR и утверждённая state transition matrix.

### I. Управление через админку

До подключения key администратор должен безопасно видеть:

- выбранные provider/model/routing/pricing policy versions;
- configured/disabled/ready/exhausted без значения secret;
- budget, actual/held cost и utilization;
- queue/running/unknown ages и worker health;
- retention/eval status и явные blockers.

Редактируемыми могут быть только заранее allowlisted versioned settings через permission → MFA → preview → confirm → execute → audit/readback. Secret вводится и ротируется вне browser UI.

Артефакт: утверждённый settings registry и operator runbook.

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
