# Backend version-list

0.0.276 - 11.07.2026 | 13:36 - Добавлен канонический `CURRENT_HANDOFF.md` для продолжения работы из нового диалога: зафиксированы состояние трёх репозиториев и стенда, уже готовый AI foundation, обязательная последовательность продуктовых решений, техническая подготовка до состояния «остаётся API key», остальные production gates, ссылки на runbooks/test-cases и правила exact-revision deploy verification. Секреты не добавлялись; runtime, OpenAPI и schema не изменены.

0.0.275 - 11.07.2026 | 13:17 - Зафиксирован отдельный AI activation roadmap перед паузой: текущее готовое состояние, последовательные решения по task/tariff matrix, provider, model routing, eval, данным/согласиям, pricing/stop-loss, safety, reconciliation и admin control plane, техническая подготовка без ключа и строгий Definition of Ready «остаётся только API key». Добавлен список остальных внешних production gates; runtime, OpenAPI и schema не изменены.

0.0.274 - 11.07.2026 | 04:15 - ADR-090 синхронизирован с уже реализованными AI-срезами: versioned task/context policies, strict structured output, schema v37 async lifecycle, read-only admin control plane и schema v38 retention больше не названы будущей работой. Внешний provider evidence и финансово значимое операторское действие для `unknown/reconciliation_hold` сохранены отдельными gates; runtime, OpenAPI и schema не изменены.

0.0.273 - 11.07.2026 | 03:58 - Синхронизирован production tracker с фактически закрытым бесплатным AI checkpoint: зафиксированы OpenAI Responses/store=false, Luna/low baseline, тарифные task/context policies, canonical async lifecycle, isolated worker, stop-loss, offline eval и 30-дневный retention на schema v38. Реальный provider остаётся fail-closed до production key, положительного месячного бюджета и evidence; операторский `unknown/reconciliation_hold` явно оставлен отдельным финансово значимым решением. Runtime, OpenAPI и schema не изменены.

0.0.272 - 11.07.2026 | 03:33 - Исправлена PostgreSQL-типизация runtime clock в AI content retention: параметры cutoff и operation expiry теперь явно приводятся к `timestamptz`, что исключает неоднозначный вывод типа `interval`. Регрессия обнаружена fail-closed smoke-запуском на VPS до обработки данных; ежедневная задача оставалась отключённой до исправления.

0.0.271 - 11.07.2026 | 03:02 - Реализован schema v38 AI content retention: отдельный daily worker под общим lease/fencing и telemetry-контуром bounded-пачками необратимо очищает только истёкшие prompt/context/message/result payloads, фиксирует `content_purged_at`, пропускает active/approved legal hold и задачи с неистёкшими operations. Provider identity, token/cost evidence, ledger, lifecycle и financial state сохраняются; повторный запуск идемпотентен, continuation после purge fail-closed. Worker остаётся opt-in через явный allowlist, OpenAPI повышен до 0.0.72.

0.0.270 - 11.07.2026 | 02:35 - Подготовлен бесплатный model-evaluation checkpoint `ai-model-eval-v1`: восемь одинаковых синтетических fixtures для Luna/Sol покрывают тарифные классы, пищевую/аллергенную/медицинскую безопасность, prompt injection и отсутствие детерминированных nutrition/cost данных. Строгий обезличенный evidence не хранит raw response, prompt или provider request id; агрегатор fail-closed проверяет полноту критериев и считает schema/correctness/safety, p50/p95 latency, tokens, exact provider cost и cost per successful task. Даже полностью пройденный gate требует ручного owner approval; provider не вызывается, worker не включается.

0.0.269 - 11.07.2026 | 02:05 - AI control plane повышен до безопасной read-only schema v3: администратор получает выбранные model/profile, факт готовности, явный месячный лимит, actual и conservative held cost, общий расход, остаток, utilization и stop-loss state. Все суммы рассчитываются exact decimal за UTC-месяц; inactive/unconfigured/exhausted различаются явно. Секрет, endpoint credentials, prompt, context, result и provider request identity не раскрываются. OpenAPI повышен до 0.0.71 для синхронизации админки.

0.0.268 - 11.07.2026 | 01:41 - Зафиксирован production pricing/stop-loss срез AI: Luna Standard получил версионированный профиль и exact decimal pricing, model/profile mismatch блокируется до provider call, а worker требует явный положительный месячный бюджет без небезопасного default. Перед новым submit общий расход UTC-месяца сериализуется advisory lock и учитывает actual либо conservative held cost; исчерпание лимита не вызывает provider и освобождает пользовательский резерв, тогда как pending/unknown сохраняют оценку и reconciliation hold. Terminal attempt сохраняет токены и actual cost; least-privilege grants, Compose, runbook, архитектурная спецификация и regression-тесты синхронизированы.

0.0.267 - 11.06.2026 | 23:51 - Реализован production async AI lifecycle schema v37: первичный запуск и continuation возвращают `202`, owner polling читает canonical lifecycle/financial state, same-key replay привязан к server request hash. Отдельный `ai-worker` использует Background Responses, file-mounted token, least-privilege DB role, bounded queue, lease/fencing и immutable attempt evidence; HTTP backend получает только несекретный признак доступности worker, а provider token остаётся в изолированном контейнере. Перед dispatch повторно проверяются account/sanction, тариф и AI/special-category consent; continuation передаёт последние 40 сообщений, включённое уточнение не создаёт финансового движения и возвращает slot при подтверждённой ошибке. Неизвестный исход и истёкший lease остаются `unknown/reconciliation_hold`. Все 37 миграций и grants реально применены на чистом изолированном PostgreSQL 18 (`228/522`); OpenAPI повышен до 0.0.70 (367 операций), добавлен операторский runbook.

0.0.266 - 11.06.2026 | 23:05 - Добавлен первый additive async-contract срез без преждевременной публикации очереди: owner-scoped `GET /api/v1/ai/operations/{id}` возвращает canonical lifecycle и независимое financial state, безопасную failure-классификацию, TTL/version/read URL и только подтверждённый результат. Prompt, personal context, provider request metadata и raw errors не раскрываются. Legacy AI routes сохранены; OpenAPI повышен до 0.0.68 (365 операций).

0.0.265 - 11.06.2026 | 22:55 - Закрыт fail-safe bridge для legacy AI execution: provider boundary различает подтверждённую ошибку, при которой резерв можно освободить, и timeout/reset/abort с неизвестным исходом. Неизвестный исход сохраняется как `ai_operations.status=unknown`, не освобождает действия и не допускает повторный provider call по тому же idempotency key; успешная/ошибочная финализация после provider call больше не зависит от повторной проверки writable user state. Полный async operation lifecycle остаётся additive следующим срезом.

0.0.264 - 11.06.2026 | 22:35 - Добавлен read-only AI control plane `GET /admin/ai`: администратор с активной MFA-сессией видит только безопасный provider status, effective task/context policy, агрегаты 24h/30d, статусы и полный tariff/context catalog 18 задач. Endpoint использует транзакционную повторную авторизацию и audit event, не возвращает prompts, персональные snapshots или секреты и не содержит мутаций. OpenAPI повышен до 0.0.67.

0.0.263 - 11.06.2026 | 22:17 - Закрыт второй AI architecture slice и schema v36: исполняемая versioned context policy связывает все 18 AI-задач с минимально необходимыми источниками, обязательные inventory/preferences проверяются до резерва, Pro nutrition context не раскрывается младшим тарифам, а immutable snapshot сохраняется с SHA-256 и consent gate. OpenAI Responses теперь использует строгий `meal_ai_result_v1` Structured Output с обязательным ручным review и fail-closed отклонением невалидного ответа.

0.0.262 - 11.06.2026 | 21:46 - Закрыт первый AI architecture slice и schema v35: версия `ai-task-policy-v3` связывает 18 task codes с effective Free/Plus/Pro entitlement, account-scoped capabilities скрывает недоступные задачи, а preview/reserve/continuation повторно применяют серверный gate. AI-баланс больше не повышает тариф; сезонность и анализ документов fail-closed до появления достоверных источников. `AI_INTERACTION_V1.md` фиксирует async lifecycle, idempotency/unknown outcome, context/consent, Structured Outputs, provider telemetry, safety, retention и admin control plane. Приняты OpenAI Responses/store=false, Luna launch baseline и дальнейшая Luna/Sol eval-стратегия.

0.0.261 - 11.04.2026 | 07:15 - Выполнен checkpoint 80F backend composition closure без изменения Nest/HTTP/OpenAPI/DB/worker behavior: монолитный 2861-line composition suite разделён на static, Worker/process и runtime/OpenAPI файлы без потери assertions. Зафиксированы root 0-controller/2 APP_GUARD ownership, recursive HTTP uniqueness 68 controllers/121 provider tokens, reachability всех 79 context modules и точный 18-token process-scoped Worker overlap при нулевых HTTP capability imports.

0.0.260 - 11.04.2026 | 07:00 - Выполнен checkpoint 80E architecture closure без изменения Nest/HTTP/OpenAPI/DB/runtime behavior: public-boundary coverage выводится из всех 67 модулей context map, `export *` запрещён, четыре закрытых library gap защищены, а точный legacy auth deep-import set зафиксирован SHA-256 ratchet. Balanced static checker валидирует 79 context modules, imports/reachability, cycles/forwardRef и duplicate controller/provider/token ownership; единственное duplicate-token исключение — ровно два root APP_GUARD.

0.0.259 - 11.04.2026 | 06:45 - Выполнен checkpoint 80D media-processing public-boundary closure без изменения Nest/HTTP/OpenAPI/DB/CDR/standalone-worker behavior: добавлен explicit named `media-processing/public.ts`, CDR child, processor worker и focused tests переведены с implementation imports, architecture gate запрещает новые обходы. Structural source-text assertions сохранены и документированы как inspection evidence, не runtime dependencies.

0.0.258 - 11.04.2026 | 06:30 - Выполнен checkpoint 80C account-mail public-boundary closure без изменения Nest/HTTP/OpenAPI/DB/standalone-worker behavior: добавлен explicit named `account-mail/public.ts`, worker, SMTP smoke и focused test переведены с implementation imports, а architecture gate теперь запрещает новые обходы границы. Structural source-text assertion processor сохранён и документирован как inspection evidence, не runtime dependency.

0.0.257 - 11.04.2026 | 06:15 - Выполнен checkpoint 80B web-push public-boundary closure без изменения Nest/HTTP/OpenAPI/DB/standalone-worker behavior: добавлен explicit named `web-push/public.ts`, standalone worker и production test переведены с implementation deep imports, а architecture gate теперь запрещает новые обходы границы. Публичный API содержит только реально используемые config reader, processor и quiet-hours projection; process-scoped worker composition сохранена.

0.0.256 - 11.04.2026 | 06:00 - Выполнен checkpoint 80A legal-runtime public-boundary closure без изменения Nest/HTTP/OpenAPI/DB/runtime behavior: добавлен explicit named `legal-runtime/public.ts`, offline readiness script и legal-release test переведены с implementation deep imports, а architecture gate теперь запрещает новые обходы границы. Публичный API содержит только пять реально используемых contracts/functions; внутренняя legal runtime реализация не раскрыта.

0.0.255 - 11.04.2026 | 05:30 - Выполнен checkpoint 79 WebPush delivery provider-chain extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `WebPushDeliveryProviderCapabilityModule` владеет disabled adapter, APP_CONFIG-injected Vapid adapter и точным `WEB_PUSH_DELIVERY_PROVIDER` selector, экспортирует только token и не имеет imports/controllers/WorkerModule usage. Standalone worker сохраняет отдельное process-scoped создание provider; email capability и два APP_GUARD не затронуты. Factory/selector identities, config injection, fail-closed selection, worker isolation и exact OpenAPI зафиксированы регрессиями.

0.0.254 - 11.04.2026 | 05:05 - Выполнен checkpoint 78 disabled email-delivery provider extraction без изменения HTTP/OpenAPI/DB/runtime behavior: provider-only `EmailDeliveryProviderCapabilityModule` владеет `DisabledEmailDeliveryProvider` и observable `EMAIL_DELIVERY_PROVIDER` useExisting alias, экспортирует только token и не имеет imports/controllers/worker usage. WebPush selector/providers и APP_GUARD entries остались root-owned. Добавлен explicit delivery-infrastructure public API; alias singleton identity, fail-closed status, root/worker isolation, deep-import boundary и exact OpenAPI зафиксированы регрессиями.

0.0.253 - 11.04.2026 | 04:45 - Выполнен checkpoint 77 generic malware-scanner provider extraction без изменения HTTP/OpenAPI/DB/runtime behavior: provider-only `MalwareScannerProviderCapabilityModule` владеет `DisabledMalwareScannerProvider` и observable `MALWARE_SCANNER_PROVIDER` useExisting alias, экспортирует только token и не имеет imports/controllers/worker usage. Предыдущие media capabilities, delivery и APP_GUARD entries не затронуты. Alias singleton identity, fail-closed status, root/worker isolation и exact OpenAPI зафиксированы регрессиями.

0.0.252 - 11.04.2026 | 04:25 - Выполнен checkpoint 76 generic key-management provider extraction без изменения HTTP/OpenAPI/DB/runtime behavior: provider-only `KeyManagementProviderCapabilityModule` владеет `DisabledKeyManagementProvider` и observable `KEY_MANAGEMENT_PROVIDER` useExisting alias, экспортирует только token и не имеет imports/controllers/worker usage. Object storage, malware, delivery и APP_GUARD entries не затронуты. Alias singleton identity, fail-closed status, root/worker isolation и exact OpenAPI зафиксированы регрессиями.

0.0.251 - 11.04.2026 | 04:05 - Выполнен checkpoint 75 generic object-storage provider extraction без изменения HTTP/OpenAPI/DB/runtime behavior: provider-only `ObjectStorageProviderCapabilityModule` владеет `DisabledObjectStorageProvider` и observable `OBJECT_STORAGE_PROVIDER` useExisting alias, экспортирует только token и не имеет imports/controllers/worker usage. Root потерял ровно эту пару; KMS/malware/delivery/APP_GUARD entries не затронуты. Alias singleton identity, fail-closed status, worker isolation, deep-import boundary и exact OpenAPI зафиксированы регрессиями.

0.0.250 - 11.04.2026 | 03:40 - Выполнен checkpoint 74 MediaStorage HTTP capability extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `MediaStorageCapabilityModule` импортирует ровно `MediaObjectStoreCapabilityModule`, владеет последним root controller и `MediaStorageService`, не экспортирует providers и полагается на global DB/config/UserSessionGuard. AppModule больше не владеет controllers; generic unused media aliases остались root-owned. Guard, object-store/service/controller singleton identity, worker isolation и exact OpenAPI зафиксированы регрессиями.

0.0.249 - 11.04.2026 | 03:15 - Выполнен checkpoint 73 MediaObjectStore prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `MediaObjectStoreCapabilityModule` владеет Disabled/S3 adapters и точным `MEDIA_OBJECT_STORE` selector factory, экспортирует только token и полагается на global APP_CONFIG. Root duplicate providers удалены; MediaStorageService/controller и unrelated generic media aliases остались root-owned. Selector/config/fail-closed semantics, service injection identity, worker isolation, deep-import boundary и exact OpenAPI зафиксированы регрессиями.

0.0.248 - 11.04.2026 | 02:55 - Выполнен checkpoint 72B StaffAuth HTTP extraction без изменения HTTP/OpenAPI/DB/runtime behavior: controller-only `StaffAuthHttpCapabilityModule` владеет `StaffAuthController`, не имеет imports/providers/exports и полагается на global AuthService/AuthCookies и token-backed `StaffSessionRouteGuard`. Root duplicate удалён; child-module wrapper и Moderator продолжают использовать один CoreRuntime StaffSessionGuard singleton; worker-isolation и exact OpenAPI зафиксированы регрессиями.

0.0.247 - 11.04.2026 | 02:35 - Выполнен checkpoint 72A shared staff-session guard ownership без изменения HTTP/OpenAPI/DB/runtime behavior: CoreRuntime единолично владеет `StaffSessionGuard` и `STAFF_SESSION_GUARD` useExisting alias; route-level `StaffSessionRouteGuard` и `ModeratorSessionGuard` делегируют одному token-owned singleton. Контроллеры не перемещались; exact provider/token identity, method metadata, negative root/worker ownership и exact OpenAPI зафиксированы регрессиями.

0.0.246 - 11.04.2026 | 01:45 - Выполнен checkpoint 71 user Auth HTTP extraction без изменения HTTP/OpenAPI/DB/runtime behavior: controller-only `UserAuthHttpCapabilityModule` владеет только `AuthController`, полагается на global CoreRuntime AuthService/AuthCookies/UserSessionGuard и не имеет imports/providers/exports. Добавлен минимальный explicit `auth/public.ts`; root duplicate удалён, а controller singleton DI, `me` guard, StaffAuth/Media root ownership, worker-isolation и exact OpenAPI зафиксированы регрессиями. APP_GUARDs и delivery aliases не затронуты.

0.0.245 - 11.04.2026 | 01:25 - Выполнен checkpoint 70 Account HTTP extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `AccountHttpCapabilityModule` импортирует только `AccountServiceCapabilityModule`, владеет `AccountController` и `MailboxController`, полагается на global `AuthCookies`, не имеет providers/exports и отсутствует в WorkerModule. Root duplicates удалены; общий AccountService/cookies singleton, global guard composition, worker isolation и exact OpenAPI зафиксированы регрессиями. Auth/StaffAuth controllers, APP_GUARDs и unused delivery aliases не затронуты.

0.0.244 - 11.04.2026 | 01:05 - Выполнен checkpoint 69 AccountService provider extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `AccountServiceCapabilityModule` импортирует ровно registration-risk, legal-consents и account-mail-outbox capabilities, полагается на global core для DB/Auth/config, экспортирует единственный `AccountService` и не владеет контроллерами. Root-owned `AccountController` и `MailboxController`, application-context lookup, все dependency singletons, global guards, worker-isolation и exact OpenAPI зафиксированы регрессиями; unused email/webpush aliases не затронуты.

0.0.243 - 11.04.2026 | 00:35 - Выполнен checkpoint 68 account-mail-outbox prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `AccountMailOutboxCapabilityModule` владеет disabled/Postgres implementations и APP_CONFIG selector, экспортирует только `ACCOUNT_MAIL_OUTBOX` sole consumer `AccountService` и не попадает в WorkerModule. Root duplicates удалены; exact metadata, selector identity для disabled/enabled config, fail-closed runtime, AccountService singleton injection, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.242 - 11.04.2026 | 00:15 - Выполнен checkpoint 67 registration-risk prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: после инвентаризации оставшихся media/account/auth/delivery providers выбран минимальный реально используемый frontier, а не неиспользуемые aliases. `RegistrationRiskCapabilityModule` владеет единственным APP_CONFIG-backed fail-closed policy factory, экспортирует `RegistrationRiskPolicy` sole consumer `AccountService`, не имеет controllers/imports и не попадает в WorkerModule. Root duplicate удалён; явный `account/public.ts`, deep-import, factory/config identity, AccountService singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.241 - 11.04.2026 | 00:05 - Выполнен checkpoint 66 Admin News HTTP capability extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminNewsCapabilityModule` импортирует ровно entitlements/legal-consents capabilities, владеет двумя controllers и тремя HTTP-context providers, включая runner для operational `app.get`, и ничего не экспортирует. DB/AdminAccess/Auth/cookies/guards остаются global core dependencies; delivery ограничена внутренним in-app helper без email/web-push/account provider DI. WorkerModule сохраняет отдельный process-scoped `ScheduledNewsRunner` через явный `admin-news/public.ts` без HTTP capability import. Root duplicates, deep imports устранены; guard/singleton/worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.240 - 11.03.2026 | 23:55 - Выполнен checkpoint 65 Admin Billing capability extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminBillingCapabilityModule` импортирует только `PaymentApplicationCapabilityModule`, единолично владеет admin-session controller/service и не экспортирует private service. Database/AdminAccess/guard остаются global core dependencies; прямого доступа к payment/refund/repository tokens нет. Root duplicates удалены, явный `admin-billing/public.ts`, deep-import, guard, application/AdminBilling singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.239 - 11.03.2026 | 23:45 - Выполнен checkpoint 64 application capability extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `PaymentApplicationCapabilityModule` импортирует ровно три prerequisite-модуля payment provider, refund provider и repository, единолично владеет и экспортирует `PaymentApplicationService` реальному root-owned `AdminBillingService`. Прямые root imports prerequisites и дубликат application provider удалены; WorkerModule payment application не получает. Exact metadata, token identity, application/AdminBilling singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.238 - 11.03.2026 | 23:35 - Выполнен checkpoint 63 provider prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `PaymentRepositoryCapabilityModule` владеет `PostgresPaymentRepository` и `PAYMENT_REPOSITORY` useExisting alias, экспортирует только token реальному root-owned `PaymentApplicationService` и использует global DatabaseService. Provider/refund capabilities, application/admin-billing не изменены, WorkerModule не получает payment repository. Exact alias/token/database identity, root-negative ownership, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.237 - 11.03.2026 | 23:25 - Выполнен checkpoint 62 provider prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `RefundProviderCapabilityModule` владеет fail-closed `DisabledRefundProvider` и `REFUND_PROVIDER` useExisting alias, экспортирует только token реальному root-owned `PaymentApplicationService`. PaymentProvider/repository/application/admin-billing не изменены, WorkerModule не получает refund providers. Exact alias/token identity, root-negative ownership, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.236 - 11.03.2026 | 23:15 - Выполнен checkpoint 61 provider prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: `PaymentProviderCapabilityModule` владеет fail-closed `DisabledPaymentProvider` и `PAYMENT_PROVIDER` useExisting alias, экспортирует только token реальному root-owned `PaymentApplicationService`. Refund/repository/application/admin-billing не объединены, WorkerModule не получает payment providers. Явный payments public API, exact alias/token identity, root-negative ownership, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.235 - 11.03.2026 | 23:05 - Выполнен checkpoint 60 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ProOverviewCapabilityModule` импортирует ровно AI и ProAccess capabilities, владеет controller/service и использует global Database/UserSessionGuard. Сервис остаётся private для Nest, live-PG root `app.get` совместим, WorkerModule сохраняет отдельный process-scoped ProAccess без HTTP capability. Exact imports/ownership/guard и database/AI/ProAccess/controller singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.234 - 11.03.2026 | 22:55 - Выполнен checkpoint 59 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AiCapabilityModule` импортирует ровно AI provider, Entitlements, LegalConsents и OperationalRuntime, владеет AI controller/service/reconciliation lifecycle и экспортирует только `AiService` реальному ProOverview consumer. ProviderObserver не является AI dependency, worker process остаётся изолирован, ProOverview не объединён. Exact imports/ownership/guard и provider/entitlements/legal/runtime/controller/ProOverview singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.233 - 11.03.2026 | 22:45 - Выполнен checkpoint 58 prerequisite extraction без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный `AiProviderCapabilityModule` владеет и экспортирует только config-only `AiProvider`, который остаётся единственным provider dependency root-owned `AiService`. AI/ProOverview не объединены преждевременно, WorkerModule не получает HTTP capability или AI provider. Явный `ai/public.ts`, exact module/root ownership, singleton identity, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.232 - 11.03.2026 | 22:31 - Выполнен checkpoint 57 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `FamilyCapabilityModule` импортирует ровно Entitlements, владеет controller/service и использует global Database/UserSessionGuard. FamilyChat/FamilyNotes остаются отдельными capabilities без DI/compile-time связи, live-PG root `app.get` совместим, worker scope не затронут. Явный public API, exact guard/database/entitlements/controller singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.231 - 11.03.2026 | 22:25 - Выполнен checkpoint 56 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `SubscriptionSettingsCapabilityModule` импортирует ровно Entitlements, владеет controller/service и использует global Database/UserSessionGuard. Payment/admin-billing providers не являются runtime dependencies и не объединены; lifecycle policy остаётся pure public API, live-PG root `app.get` совместим, worker scope не затронут. Exact guard/database/entitlements/controller singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.230 - 11.03.2026 | 22:19 - Выполнен checkpoint 55 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `FinanceCapabilityModule` импортирует ровно ProAccess, владеет Finance controller/service и использует global Database/UserSessionGuard. Inventory `requireVersion` остаётся compile-time helper без ложного Nest import, Pricing capability не изменён, worker scope не затронут. Exact guard/database/pro-access/controller singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.229 - 11.03.2026 | 22:13 - Выполнен checkpoint 54 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный `PricingCapabilityModule` импортирует ровно ProAccess, владеет Pricing controller/service и использует global Database/UserSessionGuard. Finance runtime остаётся root-owned, shared contracts доступны через явный public API, worker scope не затронут. Exact guard/database/pro-access/controller singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.228 - 11.03.2026 | 22:07 - Выполнен checkpoint 53B staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ModeratorCapabilityModule` импортирует ровно CatalogRecipes + ContentReleases и владеет controller/service/ModeratorSessionGuard. Shared StaffSessionGuard остаётся global core singleton, optional ContentReleases injection сохранён, worker scope не затронут. Явный public API, exact guard/lifecycle/releases/staff singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.227 - 11.03.2026 | 21:57 - Выполнен checkpoint 53A prerequisite без изменения HTTP/OpenAPI/DB/runtime behavior: shared StaffSessionGuard перенесён из AppModule root в CoreRuntime providers/exports и остаётся единым singleton для StaffAuthController + root ModeratorSessionGuard. Moderator controller/service/guard намеренно остаются root-owned до отдельного checkpoint 53B; другие guards, worker scope и контракты не затронуты. Root-negative/core ownership, shared-identity и exact-OpenAPI regressions фиксируют границу.

0.0.226 - 11.03.2026 | 21:51 - Выполнен checkpoint 52 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminReviewCapabilityModule` импортирует ровно ContentReleases, владеет controller/service/rollback registry и сохраняет registry boundary. Database/AdminAccess/guard остаются global; moderation и другие rollback-домены не объединены, acceptance construction сохранён через явный public API. Singleton/guard/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.225 - 11.03.2026 | 21:45 - Выполнен checkpoint 51 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AdminRuntimeSettingsCapabilityModule` владеет controller/service и `LocalBackupStatusReader` factory, сохраняя точные APP_CONFIG enabled/path semantics. Database/AdminAccess/guard остаются global; backup/maintenance/worker infrastructure не объединена и HTTP providers отсутствуют в WorkerModule. Явный public API, guard/factory/singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.224 - 11.03.2026 | 21:39 - Выполнен checkpoint 50 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный core-only `AdminReadCapabilityModule` владеет controller/service, не имеет imports/exports и использует global DatabaseService/AdminSessionGuard. Он намеренно отделён от observability `AdminReadBoundaryCapabilityModule`; worker/process scope не затронут. Явный public API, guard/database singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.223 - 11.03.2026 | 21:32 - Выполнен checkpoint 49 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminContentCapabilityModule` импортирует ровно CatalogRecipes + ContentReleases, владеет controller/service и сохраняет optional releases injection. Database/AdminAccess/guard остаются global; moderation/admin-review/rollback не объединены, live-PG process продолжает root `app.get`. Явный public API, guard/lifecycle/releases singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.222 - 11.03.2026 | 21:27 - Выполнен checkpoint 48 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminObservabilityCapabilityModule` импортирует ровно AdminReadBoundary capability, владеет controller/service/repository и сохраняет HostSnapshotReader factory с APP_CONFIG enabled/path semantics. Worker/provider runtime schemas остаются compile-time без Nest imports; providers private и отсутствуют в WorkerModule. Явный public API, guard/boundary/repository/factory singleton, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.221 - 11.03.2026 | 21:22 - Выполнен checkpoint 47 prerequisite без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный `AdminReadBoundaryCapabilityModule` владеет и экспортирует transaction authorization/audit boundary единственному HTTP DI consumer AdminObservabilityService, используя только global DatabaseService. Observability controller/service/repository/HostSnapshotReader factory остаются root-owned до отдельного checkpoint; worker не затронут. Singleton/worker-isolation/exact-OpenAPI regressions фиксируют границу.

0.0.220 - 11.03.2026 | 21:17 - Выполнен checkpoint 46 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `NotificationsCapabilityModule` владеет двумя user controllers/services и использует только global Database/APP_CONFIG/UserSessionGuard. Web Push/email delivery, account-mail outbox, provider tokens и admin notifications не входят в capability. Явный public API, dual-guard/service singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.219 - 11.03.2026 | 21:12 - Выполнен checkpoint 45 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный core-only `AdminAcceptanceTestsCapabilityModule` владеет controller/service/repository и использует только global Database/APP_CONFIG/AdminSessionGuard. Catalog/contracts остаются compile-time API, tokens/factories/worker providers отсутствуют. Явный public API, guard/repository singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.218 - 11.03.2026 | 21:04 - Выполнен checkpoint 44 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный core-only `AdminAuthCapabilityModule` владеет только HTTP controller и использует global Auth/Cookies/AdminAccess/AdminSessionGuard. AdminReadBoundary, global AdminNetworkGuard binding и process-scoped Worker AdminAccess сохраняют прежних владельцев. Явный public API, protected-method guards/singletons/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.217 - 11.03.2026 | 20:58 - Выполнен checkpoint 43 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `RecipeWorkspaceCapabilityModule` импортирует ровно catalog-recipes/entitlements/legal-consents/content-releases, владеет controller/service и сохраняет optional releases injection. Recipes nutrition schema остаётся compile-time dependency без Nest import; private service не экспортируется и отсутствует в WorkerModule. Явный public API, guard/all-dependency singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.216 - 11.03.2026 | 20:52 - Выполнен checkpoint 42 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AccountLifecycleCapabilityModule` импортирует ровно CriticalReauth, владеет user/admin controllers и lifecycle service, полагаясь на global DB/Auth/AdminAccess/guards. Private service остаётся доступен retention process через root `app.get`, WorkerModule не получает HTTP capability/provider. Existing explicit public API, dual-guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.215 - 11.03.2026 | 20:46 - Выполнен checkpoint 41 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный core-only `AdminGovernanceCapabilityModule` владеет HTTP controller/service, не импортирует billing/family/notifications/moderation и сохраняет отдельный process-scoped service в WorkerModule. Явный public API, admin-guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.214 - 11.03.2026 | 20:44 - Выполнен checkpoint 40B staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ExportsCapabilityModule` импортирует ровно CriticalReauth + ProAccess, владеет controller/service и сохраняет process `app.get` без лишнего export или storage/token abstractions. Явный public API, guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.213 - 11.03.2026 | 20:39 - Выполнен checkpoint 40A staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный `CriticalReauthCapabilityModule` владеет и экспортирует единый HTTP singleton для Account Lifecycle и Exports, полагаясь только на global core. Явный public API, singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.212 - 11.03.2026 | 20:32 - Выполнен checkpoint 39 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `AdminOperationsCapabilityModule` владеет HTTP controller/workspace/maintenance services, не объединяя observability, rollback или scheduler; WorkerModule сохраняет отдельный maintenance provider. Явный public API, admin-guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.211 - 11.03.2026 | 20:27 - Выполнен checkpoint 38 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный безопасный `InventoryIngestCapabilityModule` владеет controller/service и использует только global Database/APP_CONFIG/UserSessionGuard; OCR/media/provider Nest dependencies отсутствуют. Явный public API, guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.210 - 11.03.2026 | 20:22 - Выполнен checkpoint 37 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `NutritionCapabilityModule` владеет controller/service и импортирует только ProAccess + LegalConsents capabilities; Diary/Inventory остаются compile-time dependencies, MealPlan не подключается. Явный public API, guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.209 - 11.03.2026 | 20:17 - Выполнен checkpoint 36 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `FamilyChatCapabilityModule` владеет controller/service и импортирует только Entitlements capability, не объединяя Family, Family Notes или media. Явный public API, root-negative ownership, guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.208 - 11.03.2026 | 20:12 - Выполнен checkpoint 35 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный пользовательский `PersonalizationCapabilityModule` владеет controller/service и импортирует ровно Recommendations + LegalConsents capabilities. Явный public API, root-negative ownership, guard/singleton/worker-isolation, deep-import и exact-OpenAPI regressions фиксируют границу.

0.0.207 - 11.03.2026 | 20:06 - Выполнен checkpoint 34 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ProviderObservationCapabilityModule` владеет оставшимся `ProviderObserver`, импортирует ровно `TelemetryCapabilityModule` и не экспортирует private provider. Secret-provider остаётся отдельной границей. Exact metadata, telemetry-token singleton, worker-isolation, deep-import и exact-OpenAPI regressions фиксируют ацикличную композицию.

0.0.206 - 11.03.2026 | 20:01 - Выполнен checkpoint 33 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: provider-runtime разделён по ответственности, и минимальный `SecretProviderCapabilityModule` в `integrations` владеет disabled secret provider/private alias без telemetry imports. ProviderObserver остаётся root до отдельного telemetry-dependent шага. Явный `provider-runtime/public.ts`, deep-import, alias-singleton, retained-observer, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.205 - 11.03.2026 | 19:53 - Выполнен checkpoint 32 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный provider-only `OcrCapabilityModule` в `integrations` владеет disabled provider и private `OCR_PROVIDER` useExisting alias, не импортирует media/main-AI/provider-runtime capabilities и не экспортирует неиспользуемый token. Явный `ocr-infrastructure/public.ts`, deep-import, alias-singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.204 - 11.03.2026 | 19:47 - Выполнен checkpoint 31 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `FamilyNotesCapabilityModule` в `household-entitlements` импортирует ровно entitlements capability, владеет controller/service и не экспортирует private service. Global DatabaseService/UserSessionGuard сохранены; Family и Family Chat не объединены. Явный `family-notes/public.ts`, deep-import, singleton, guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.203 - 11.03.2026 | 19:41 - Выполнен checkpoint 30 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AdminFreeAiCapabilityModule` в `integrations` владеет controller/service, использует global DatabaseService/AdminAccess/AdminSessionGuard и не импортирует main AI/provider/observability capabilities. AI bucket schema остаётся compile-time dependency, service не экспортируется. Явный `admin-free-ai/public.ts`, deep-import, singleton, guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.202 - 11.03.2026 | 19:35 - Выполнен checkpoint 29 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный `ProfilesCapabilityModule` в `identity-access` импортирует ровно legal-consents capability, владеет controller/service и не экспортирует private service. Global DatabaseService/UserSessionGuard сохранены, публичный author route остаётся anonymous. Явный `profiles/public.ts`, deep-import, singleton, method-guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.201 - 11.03.2026 | 19:25 - Выполнен checkpoint 28 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AdminActionsCapabilityModule` в `platform-operations` владеет controller/service, использует global AdminSessionGuard/DatabaseService и не объединяет notifications/observability/rollback. Audit/idempotency остаются private Kysely workflow, service не экспортируется. Явный `admin-actions/public.ts`, deep-import, singleton, guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.200 - 11.03.2026 | 19:19 - Выполнен checkpoint 27 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AdminNotificationsCapabilityModule` в `platform-operations` владеет notification-center controller/service, использует global AdminSessionGuard/DatabaseService и не импортирует delivery capabilities. DB workflow остаётся внутренним, service не экспортируется. Явный `admin-notifications/public.ts`, deep-import, singleton, guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.199 - 11.03.2026 | 19:14 - Выполнен checkpoint 26 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: минимальный core-only `HealthCapabilityModule` в `platform-operations` единолично владеет health controller, использует global DatabaseService и не объявляет ceremonial providers/exports. Root duplicate удалён, worker не затронут; явный `health/public.ts`, deep-import, singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.198 - 11.03.2026 | 19:09 - Выполнен checkpoint 25 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AdminSupportCapabilityModule` в `community-content` владеет controller/service, использует global AdminSessionGuard/DatabaseService, не импортирует business capabilities и не экспортирует private service. Workflow helpers остаются private, AI Appeals и user Support не объединены. Явный `admin-support/public.ts`, deep-import, singleton, guard, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.197 - 11.03.2026 | 19:03 - Выполнен checkpoint 24 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: меньший core-only frontier `AiAppealsCapabilityModule` в `community-content` владеет controller/service, не импортирует business capabilities и не экспортирует private service. Support остаётся compile-time contract dependency через public API; Admin Support не затронут. Явный `ai-appeals/public.ts`, deep-import, singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.196 - 11.03.2026 | 18:57 - Выполнен checkpoint 23 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `CommunityCapabilityModule` в `community-content` владеет feed/comments controller/service, не импортирует business capabilities и не экспортирует private service. Recipes остаётся compile-time public model dependency; Support, AI appeals и admin support не затронуты. Явный `community/public.ts`, deep-import, singleton, worker-isolation и exact-OpenAPI regressions фиксируют границу.

0.0.195 - 11.03.2026 | 18:50 - Выполнен checkpoint 22 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `SupportCapabilityModule` в `community-content` владеет controller/service, не импортирует business capabilities и не экспортирует private service. Workflow остаётся Kysely-логикой сервиса без ceremonial repository/token; root duplicates удалены, worker не затронут. Явный `support/public.ts`, deep-import, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.194 - 11.03.2026 | 18:45 - Выполнен checkpoint 21 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `PrivacyCapabilityModule` в `identity-access` владеет controller/service, не импортирует business capabilities и не экспортирует private service. Root duplicates удалены, worker не затронут; явный `privacy/public.ts`, deep-import, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.193 - 11.03.2026 | 18:40 - Выполнен checkpoint 20 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `MealPlanCapabilityModule` в `planning-health` импортирует ровно entitlements/diary capabilities, владеет двумя controllers/service и не экспортирует private service. Recipes/inventory planning helpers остаются compile-time, recommendations/nutrition providers не являются DI dependencies. Root duplicates удалены, worker не затронут; явный `meal-plan/public.ts`, deep-import, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.192 - 11.03.2026 | 18:33 - Выполнен checkpoint 19 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `DiaryCapabilityModule` в `planning-health` импортирует ровно pro-access/legal-consents capabilities, владеет controller/service и экспортирует service единственному HTTP DI consumer MealPlan. Worker сохраняет отдельный process-scoped DiaryService с worker-owned dependencies через `diary/public.ts`; inventory/nutrition связи остаются compile-time. Root duplicates удалены, deep-import, HTTP/worker singleton и exact-OpenAPI regressions фиксируют границу.

0.0.191 - 11.03.2026 | 18:26 - Выполнен checkpoint 18 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ReceiptsCapabilityModule` в `inventory-commerce` импортирует ровно entitlements/pro-access capabilities, единолично владеет двумя controllers/services и не экспортирует private providers. Purchase store остаётся набором transaction functions без ceremonial repository/token; shopping/inventory/cooking связи остаются compile-time. Root duplicates удалены, worker не затронут; явный `receipts/public.ts`, deep-import, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.190 - 11.03.2026 | 18:19 - Выполнен checkpoint 17 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ProAccessCapabilityModule` в `household-entitlements` импортирует ровно entitlements capability, единолично владеет и экспортирует `ProAccessService` семи HTTP DI consumers. ProOverview controller/service остаются root до выделения AI prerequisite; worker сохраняет отдельный process-scoped ProAccess provider для Diary. Явный `pro-overview/public.ts`, deep-import, all-consumer singleton, worker isolation и exact-OpenAPI regressions фиксируют границу и разблокируют последующие receipts/diary capabilities.

0.0.189 - 11.03.2026 | 18:12 - Выполнен checkpoint 16 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `SearchCapabilityModule` в `catalog-recipes` единолично владеет controller/service, не импортирует business capabilities и не экспортирует private service. Recipes image projection остаётся compile-time public dependency, root duplicates удалены, worker composition не затронут; явный `search/public.ts`, deep-import, exact metadata, singleton и exact-OpenAPI regressions фиксируют границу. Receipts/meal-plan отложены до выделения их root/worker-shared DI prerequisites.

0.0.188 - 11.03.2026 | 18:05 - Выполнен checkpoint 15 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ShoppingCapabilityModule` в `inventory-commerce` владеет controller/service, импортирует ровно recipes/entitlements capabilities и не экспортирует private service. Inventory/cooking/receipts остаются только compile-time dependencies, root duplicates удалены, worker composition не затронут; явный `shopping/public.ts`, deep-import, exact metadata, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.187 - 11.03.2026 | 17:57 - Выполнен checkpoint 14 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `CookingCapabilityModule` в `catalog-recipes` владеет двумя controllers и service/lifecycle/statistics-policy providers, импортирует ровно recipes/operational-runtime/content-releases capabilities и не экспортирует private providers. Inventory/preserves остаются только compile-time public dependencies, root duplicates удалены, worker сохраняет отдельный process-scoped lifecycle provider; явный `cooking/public.ts`, deep-import, exact metadata, singleton и exact-OpenAPI regressions фиксируют границу.

0.0.186 - 11.03.2026 | 17:50 - Выполнен checkpoint 13 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `ContentReleasesCapabilityModule` в `community-content` импортирует ровно legal-consents capability, единолично владеет двумя controllers/service и экспортирует service пяти реальным HTTP DI consumers. Внутренний `ReputationAchievementsService` не превращён в Nest provider; root duplicates удалены, worker composition остаётся изолированным, а явный `content-releases/public.ts`, deep-import, exact metadata, multi-consumer singleton и exact-OpenAPI regressions фиксируют границу.

0.0.185 - 11.03.2026 | 17:37 - Выполнен checkpoint 12 staged composition без изменения HTTP/OpenAPI/DB/legal behavior: core-only `LegalConsentsCapabilityModule` единолично владеет двумя controllers/service/guard/database provider и private provider-token alias, экспортируя только service реальным HTTP DI consumers. Root duplicates удалены, явный `legal-consents/public.ts` стал source/shared/test/worker API; `WorkerModule` сохраняет отдельные process-scoped legal providers без HTTP capability import. Deep-import, provider-alias, all-consumer singleton и exact-OpenAPI regressions расширены.

0.0.184 - 11.03.2026 | 17:29 - Выполнен checkpoint 11B staged composition без изменения HTTP/OpenAPI/DB/worker behavior: явный `operational-runtime/public.ts` стал единым library API для source/infrastructure/scripts/tests. HTTP `OperationalRuntimeCapabilityModule` импортирует ровно telemetry capability, единолично владеет/экспортирует `WorkerRuntimeFactory`; root duplicate удалён, AI reconciliation и cooking lifecycle получают тот же singleton. Telemetry sink остаётся private-owned telemetry provider, а `WorkerModule` сохраняет отдельный process scope без HTTP capability imports.

0.0.183 - 11.03.2026 | 17:21 - Выполнен checkpoint 11A staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: HTTP `TelemetryCapabilityModule` единолично владеет controller/repository/service/provider+worker adapters и provider-token alias, экспортируя только service/sink/token реальным root consumers. Root duplicates удалены, явный `telemetry/public.ts` разделяет library API и Nest exports; `WorkerModule` сохраняет отдельные process-scoped providers и не импортирует HTTP capability. Deep-import, singleton/token/filter/exact-OpenAPI regressions расширены.

0.0.182 - 11.03.2026 | 17:06 - Выполнен checkpoint 10 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `PreservesCapabilityModule` импортирует ровно entitlements, единолично владеет controller/service и не экспортирует private service. Compile-time inventory model dependency не превращён в Nest import; узкий явный `preserves/public.ts` публикует только нужные response/QR contracts и `consumePreserveContainer` для cooking. Root duplicates удалены, deep-import и singleton/exact-OpenAPI regressions расширены; cooking composition не затрагивался.

0.0.181 - 11.03.2026 | 17:00 - Выполнен checkpoint 9 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: composite `RecipesCapabilityModule` импортирует ровно entitlements/recommendations/allergen capabilities, единолично владеет controller/service и экспортирует service реальным DI-consumers cooking/shopping. Root duplicates удалены, все внешние source/shared/test consumers переведены на явный `recipes/public.ts`, deep-import, exact dependency/no-reverse-import и multi-consumer singleton/OpenAPI regressions расширены; cooking/shopping/search/workspace composition не затрагивался.

0.0.180 - 11.03.2026 | 16:54 - Выполнен checkpoint 8 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `AllergenIntelligenceCapabilityModule` единолично владеет двумя controllers/service, не импортирует business capabilities и экспортирует service реальному DI-consumer `RecipesService`. Root duplicates удалены, внешние contracts/service/shared consumers переведены на явный `allergen-intelligence/public.ts`, deep-import и multi-controller singleton/exact-OpenAPI regressions расширены; recipes composition не затрагивался.

0.0.179 - 11.03.2026 | 16:48 - Выполнен checkpoint 7 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `RecommendationsCapabilityModule` явно импортирует entitlements, единолично владеет controller/service и экспортирует service реальным DI-consumers — personalization и recipes. Root duplicates удалены, внешние source/shared/test consumers переведены на явный `recommendations/public.ts`, deep-import и multi-consumer singleton/exact-OpenAPI regressions расширены; allergen/recipes composition не затрагивался.

0.0.178 - 11.03.2026 | 16:25 - Выполнен checkpoint 6 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: core-only `ProductsCapabilityModule` единолично владеет `ProductsController`/`ProductsService`, не импортирует business capabilities и использует только global core database/session guard. Private service не экспортируется, root duplicates удалены, внешние shared/test consumers переведены на явный `products/public.ts`, deep-import и singleton/exact-OpenAPI regressions расширены; inventory-ingest/recipes/search не затрагивались.

0.0.177 - 11.03.2026 | 16:15 - Выполнен checkpoint 5 staged composition без изменения HTTP/OpenAPI/DB/runtime behavior: `InventoryCapabilityModule` единолично владеет `InventoryController`/`InventoryService`, явно импортирует `EntitlementsCapabilityModule`, использует global core runtime и не экспортирует private service без production DI-consumers. Root duplicates удалены, внешние source/shared/test/worker consumers переведены на явный `inventory/public.ts` без wildcard exports, deep-import и singleton/exact-OpenAPI regressions расширены; `inventory-ingest` и декомпозиция service не затрагивались.

0.0.176 - 11.03.2026 | 16:08 - Выполнен checkpoint 4 staged composition без изменения API/DB/runtime: ADR фиксирует два текущих context SCC и запрещает `forwardRef`/mega-context как миграционную стратегию; target остаются bounded-context Nest modules, промежуточный путь — малые acyclic capabilities. `EntitlementsCapabilityModule` единолично владеет controller/service и экспортирует только service, root duplicates удалены, все consumers переведены на `entitlements/public.ts`, deep-import gate и singleton/OpenAPI regressions расширены.

0.0.175 - 11.03.2026 | 15:55 - Выполнен checkpoint 3 Nest composition без изменения HTTP/OpenAPI/DB/runtime behavior: global `CoreRuntimeModule` единолично владеет APP_CONFIG/database/auth/admin-access/cookies и двумя session guards, а `CatalogRecipesModule` — RecipePolicyController и policy/lifecycle services с экспортом тех же singleton instances legacy consumers. Эти providers/controller удалены из AppModule; runtime regression подтверждает identity injections и exact OpenAPI contract.

0.0.174 - 11.03.2026 | 15:35 - Выполнен checkpoint 2 architecture pilot без изменения HTTP/OpenAPI/DB/runtime semantics: `recipe-policy` и `recipe-lifecycle` получили явные `public.ts`, все application/shared/test/acceptance consumers переведены с deep imports, а gate запрещает новые обходы public API. Чистые quota-window, public-reason и lifecycle-projection policies отделены от Nest/Kysely; существующие services сохранены как transaction-compatible application façады без пустых layers/repositories.

0.0.173 - 11.03.2026 | 15:25 - Зафиксирован checkpoint 1 backend architecture без изменения runtime/API/DB: ADR и machine-readable ownership map назначают все 67 модулей ровно одному из 8 logical contexts, а architecture gate сохраняет прежние запреты app-import/cycles и вводит exact ratchet для текущих 148 cross-module edges. Любое новое, удалённое, duplicate/stale ребро, неизвестный модуль или неполное ownership теперь fail closed; baseline описывает текущий долг, а не целевое разрешение зависимостей.

0.0.172 - 11.03.2026 | 15:10 - Устранён schema-contract drift без изменения публичного API: readiness теперь fail-closed сверяет точную последовательную migration history с `database/manifest.json`, bootstrap/restore/rollback gates читают schema/table/FK/PostgreSQL facts из candidate или backup manifest, grants и recovery/database/media runbooks синхронизированы с schema v34 и recovery contract v9. Добавлены focused regressions против независимых literals версии; OpenAPI 0.0.65 и сама schema v34 не изменены.

0.0.171 - 11.03.2026 | 14:21 - Закрыт checkpoint 11 reliability без изменения runtime/API: полный backend check 395/395 и audit 0; contracts consumers синхронизированы с OpenAPI 0.0.65; на VPS пройдены PostgreSQL/application restart с сохранением schema/data counters, all-component verify, frontend immutable rollback/roll-forward и bounded production load с ожидаемым global 200/min `429` boundary и восстановлением до 200. Уточнено точное имя `meal-local-backup.timer`; encrypted snapshots и расписание 01:00 Asia/Yekaterinburg подтверждены. Внешние provider/physical-device gates остаются явно открыты.

0.0.170 - 11.03.2026 | 12:50 - Runtime settings дополнен отдельной read-only вкладкой `Recovery-доступ`: она показывает только фиксированные пути recovery password/repository, root-only способ чтения, правила независимого хранения и безопасную последовательность restic-ротации. Значение password, его hash и reveal/copy endpoint отсутствуют; независимая копия честно остаётся неподтверждённым owner input. OpenAPI повышен до 0.0.65; schema v34 и grants не изменены.

0.0.169 - 11.02.2026 | 22:59 - Добавлен authenticated-encrypted локальный backup на restic: ежедневный timer `01:00 Asia/Yekaterinburg`, 7 daily + 4 weekly, disk guard, общий deploy lock, validated PostgreSQL/media/manifests snapshot и изолированный PG18 restore drill с RPO 24h/RTO 4h. Root-owned recovery password никогда не выводится; bounded status безопасно проецируется в admin runtime settings и всегда сохраняет `offsite=false`. Публичный HTTP API и schema v34 не изменены.

0.0.168 - 11.02.2026 | 20:15 - Web Push worker provisioning дополнен минимальным column-level `SELECT(job_id,attempt)` для безопасного `INSERT ... ON CONFLICT` в append-only attempts. Недостающий privilege обнаружен реальным пустым production-циклом; после точечного grant worker сменил health `degraded` на `ok`. Полный `SELECT` на таблицу и расширение доступа к уведомлениям не выдаются.

0.0.167 - 11.02.2026 | 20:06 - Production image теперь явно включает runtime и healthcheck scripts Web Push worker. Добавлена регрессионная проверка Dockerfile после обнаруженного на VPS fail-closed `MODULE_NOT_FOUND`; до исправления feature был немедленно выключен, push-worker удалён, а основной stack повторно прошёл полный verify.

0.0.166 - 11.02.2026 | 19:50 - Исправлена migration 034 на штатной чистой PostgreSQL: `pgcrypto` теперь устанавливается самой транзакционной миграцией, а SHA-256 backfill использует schema-qualified `public.digest`. Добавлена регрессионная проверка; исправление подтверждено на тестовом VPS в откатываемой диагностической транзакции и не меняет HTTP API.

0.0.165 - 11.02.2026 | 18:30 - Подготовлен production Web Push checkpoint: additive browser subscription API, AES-256-GCM session-bound bindings, VAPID provider, durable multi-device jobs/append-only attempts, bounded TTL/topic/retry и exact 404/410 revocation. Retry разрешён только для 429/5xx с bounded Retry-After; остальные 4xx и неизвестный исход terminal. Enqueue, claim и pre-send повторно проверяют active/unsanctioned user, live linked session и marketing consent. Добавлены migration 034, least-privilege push runtime, hardened opt-in worker overlay и runbook. Admin runtime-settings предоставляет вкладочный safe registry без значений секретов и versioned critical preview/execute для quiet-hours/TTL policy. По умолчанию feature выключен до генерации и установки root-owned VAPID/encryption secrets на VPS.

0.0.164 - 11.02.2026 | 17:30 - Устранена гонка параллельных автодеплоев трёх репозиториев: общий deployment lock теперь ожидается ограниченные 300 секунд вместо немедленного exit 75. Настройка `DEPLOY_LOCK_WAIT_SECONDS` fail-closed валидируется в диапазоне 1–900 секунд; добавлены regression assertions и обновлён deployment runbook. Исправление основано на реальном столкновении admin/backend rollout; не меняет API или runtime приложения.

0.0.163 - 11.02.2026 | 17:11 - OCR checkpoint 7 принят на VPS и оставлен включённым: authenticated RU+EN HTTPS preview вернул confidence 96 и `requiresReview: true` без изменения media/intake/recognition/receipt/inventory counts. Wrong-token 401, concurrent busy 503, process crash restart 0→1, isolated 64 MiB OOM exit 137, post-OCR RSS и full deployment verify прошли. Исправлен false-negative topology verify: пустая строка Docker template теперь отбрасывается до exact private-network comparison. Добавлен client deadline regression и зафиксировано deployment evidence; durable media/scanner остаются fail-closed.

0.0.162 - 11.02.2026 | 16:48 - Подготовлен production-safe OCR preview checkpoint: отдельный no-egress/no-storage/no-DB sidecar с one-job concurrency, 512 MiB/0.75 CPU/64 PID, root-owned token, RU+EN model checksum gate, 12 MP CDR и strict bounded response. Production не позволяет inline OCR без точного internal endpoint/secret; каждый ответ требует `requiresReview: true`, не пишет в БД/storage и не меняет domain state. Добавлены enable/disable/rollback runbook и regression tests; активация остаётся выключенной до VPS drill и совместимого frontend rollout.

0.0.150 - 10.29.2026 | 20:15 - Синхронизированы production runbook, OpenAPI metadata и readiness tracker с фактическими автодеплоями: schema v30/миграция 030, 30/212/488 migration/table/FK counts, backend 0.0.149 и admin 0.0.125 evidence, завершённая observability-приёмка. Recovery contract v5, bootstrap restore и reference-data gate теперь fail-closed требуют точную schema v30; технические origins явно отмечены как текущие, custom-domain cutover — pending до DNS. Публичный HTTP API не изменён.

0.0.149 - 10.29.2026 | 17:05 - Добавлен versioned admin acceptance checklist для 83 кейсов БД/backend/admin/frontend: semantic catalog IDs и checksums, отдельный run на catalog version, CAS/idempotency, bounded comments, reset без удаления истории, append-only events и admin-only live MFA/session/role recheck. Миграция 030 добавляет три least-privilege таблицы; OpenAPI 0.0.61 расширен тремя согласованными endpoint-ами, manual test docs и regression coverage синхронизированы.

0.0.148 - 10.29.2026 | 16:03 - Подготовлены канонические meal/admin origins: TLS-edge шаблон, временные 302 rollback aliases, public-origin verification и точный cutover/rollback runbook.

0.0.147 - 10.29.2026 | 15:37 - Observability checkpoint закрыт после полной VPS-приёмки: hardened systemd collector/timer, exact file metadata, atomic и Docker-degraded partial сценарии, compose mount/socket verification, real admin+MFA snapshot и четыре темы админки подтверждены. Admin 0.0.124 прошёл CI/image/deploy runs 40857924493/40858092836; tracker и runbook синхронизированы без изменения API, БД или runtime backend.

0.0.146 - 10.29.2026 | 15:01 - VPS bootstrap drill выявил отсутствие `/etc/sysusers.d` на чистом Ubuntu 24.04 до изменения Compose. Runbook теперь явно создаёт root-owned системные каталоги sysusers/tmpfiles вместе с libexec до установки artifacts; regression test фиксирует порядок. Удалён неработающий для `Type=oneshot` `RuntimeMaxSec`; bounded runtime остаётся на `TimeoutStartSec=30`. Приложение и БД при неуспешной попытке не затрагивались.

0.0.145 - 10.29.2026 | 14:41 - Усилен observability deployment/security gate: reader требует exact root:29002 metadata 2750/0640 для parent/file и ограничивает возраст старых snapshots; verify проверяет единственный backend RO mount, отсутствие observability/docker socket у остальных containers и прогоняет строгий reader. Host bootstrap обязателен до rollout, проверяет staged candidate checksums и сохраняет checksummed root-artifact backup; disabled mode сохраняет безопасный mount. Collector без systemd-зависимости от Docker успешно публикует fresh partial snapshot при ожидаемой Docker-деградации. Endpoint ограничен 12 запросами/мин, aggregate transaction — statement timeout 2s. Runtime checkpoint остаётся in-progress до VPS smoke; DB schema/grants и response payload не менялись.

0.0.144 - 10.29.2026 | 14:16 - Добавлен admin-only observability endpoint с live MFA/role/session recheck и audit, bounded host/DB/queue/worker/provider snapshot, строгими freshness/no-samples/stale/unavailable semantics и без identifiers/raw errors. Host/container данные собирает отдельный root-owned hardened systemd collector в atomic sanitized JSON; backend получает только read-only directory mount без Docker socket. Добавлены fail-closed config/disable/rollback runbook и regression/static tests; HTTP API расширен только согласованным GET, DB schema/grants не менялись.

0.0.143 - 10.29.2026 | 14:02 - Исправлена runtime-проверка нового worker container: deploy verification теперь ограниченно ждёт Docker health до 90 секунд и не считает штатный `start_period` ошибкой. Добавлен regression-контракт bounded wait; HTTP/API/DB schema/URL/payload не менялись.

0.0.142 - 10.29.2026 | 13:28 - Добавлен отдельный production worker/scheduler на том же immutable backend image: пустой fail-closed allowlist из пяти безопасных задач, global concurrency 1, PostgreSQL lease/fencing, bounded timeout с TERM/KILL, jitter/backoff и poison isolation, graceful shutdown и low-cardinality health evidence. Первый запуск отложен на полный interval, повторное планирование считается от completion time без catch-up, `skipped_overlap` сохраняет failure history, а DB pool первого cutover ограничен двумя соединениями. Worker использует минимальный DI-модуль без HTTP-auth/MFA/provider secrets, hardened container без ingress, а production compose явно отключает embedded loops; destructive retention требует отдельного versioned approval. Обновлены deploy/verify/runbook и regression-тесты restart/overlap/lease-loss/timeout/poison/config/compose без изменения HTTP/API/DB schema/URL/payload.

0.0.141 - 10.29.2026 | 12:43 - Уточнена внутренняя архитектура без изменения HTTP/API/DB/URL: operational readiness теперь тестируемо отражает готовые schema-v29 lease и telemetry capabilities; добавлен CI-gate направлений зависимостей и циклов; AppConfig contract перенесён в shared; единая WorkerRuntimeFactory устранила три concrete-сборки; разорваны четыре междоменных SCC через нейтральные account/workflow/scope/recipe primitives; reputation и achievements выделены из content-release orchestration за совместимым facade.

0.0.140 - 10.29.2026 | 12:06 - Синхронизированы 11 пользовательских legal draft-текстов с согласованной заглушкой `[Тут будут данные]` при сохранении `draft_blocked`/`publicationEligible:false`; добавлен regression-test, исключающий случайную публикацию. Зафиксирован последовательный бесплатный production tracker и точный owner-input checklist для observability, email, storage/scanner, OCR, push, backup и будущего AI; API, схема БД и consent evidence не менялись.

0.0.139 - 10.29.2026 | 11:23 - Актуализированы live Docker inventory и единый production TODO по данным read-only legacy root и текущего operational-readiness: отдельно отмечен закрытый Docker/schema v29 cutover тестового стенда и зафиксирован последовательный план внешних gates — legal/data processing, off-host backup/observability, email, storage/scanner, OCR, payments/receipts/refunds, push, AI, workers/shared lease и финальная физическая приёмка. Provider credentials и публичные контракты не добавлялись.

0.0.138 - 10.29.2026 | 11:12 - Post-deploy verify адаптирован к Docker 29.9: служебное значение `invalid IP` у internal network больше не превращается в ложный trusted proxy gateway. Gate принимает только валидные IPv4, а production smoke зафиксировал единственный фактический Nginx source `172.31.0.1/32`; широкие сети и internal DB gateway не доверяются.

0.0.137 - 10.29.2026 | 11:05 - Production readiness подтвердил, что точечные table grants не работают без schema traversal: `application-grants.sql` теперь явно выдаёт `meal_app` только `USAGE` на schema `meal`, сохраняя `CREATE=false`. Это синхронизирует фактические grants с ранее документированным least-privilege контрактом и позволяет readiness использовать разрешённую `schema_migrations`; публичные DTO и endpoint-ы не менялись.

0.0.136 - 10.29.2026 | 10:17 - В deployment runbook добавлена краткая карта для человека и агента: `main`/GHCR digest, allowlisted helper, server paths, ports, health, first restore и rollback boundary. Добавлен `meal-planner-compose.service`, который после reboot идемпотентно поднимает текущие digests без автомиграций. Первый production cutover устранил fail-closed проблемы restore/secrets и readiness: bootstrap корректно читает root-only dump и подключает `pg_restore` ролью `meal_owner`, backend/migrate получают отдельный supplemental GID `29001`, а Pool сохраняет URI option `-c role=meal_app` при добавлении timezone/search_path; секреты не добавлялись.

0.0.135 - 10.29.2026 | 10:13 - В repository deployment contract добавлен точный host-Nginx template для TLS edge: public origin проксирует API/health/frontend на loopback `3001/3000`, admin origin — API/backend и SPA container на `3002`; сертификаты, security headers и firewall boundary сохранены.

0.0.134 - 10.29.2026 | 10:06 - Compose observation commands в production runbook синхронизированы с фактическим deployment layout: helper-файлы лежат в `/srv/meal/deployment`, non-secret settings читаются из `/etc/meal-planner/deploy.env`, а текущие digests — из root-owned `images.env`; runtime/API не изменялись.

0.0.133 - 10.29.2026 | 09:47 - Docker build context включает `contracts/http-cases.json`, который нужен TypeScript-сборке contract-теста; исправлен Linux-only container build failure без изменения runtime/API.

0.0.132 - 10.28.2026 | 17:51 - Добавлена production Docker/Compose и GitHub Actions инфраструктура общего стека с immutable digest images, явными migration/backup/verify/rollback gates и hardening; Docker secrets поддержаны через безопасные `_FILE` переменные. Recovery contract синхронизирован со schema v29 / 483 FK, runtime-role документирован как `meal_runtime` login с effective `role=meal_app`, а runbook переведён с legacy systemd/symlink smoke на фактический Compose health/rollback/observation и фиксирует текущий legacy health-route blocker.

0.0.131 - 28.10.2026 | 13:12 - Docs-only repository revision синхронизирует live admin `0.0.117` и immutable release `20261028-0757`: root/deep-link отвечают `200`, password → mandatory MFA и `coffee-light` / `nature-dark` smoke прошли без runtime errors. Deployed backend остаётся `0.0.128` / schema v29; runtime-код и публичные контракты не менялись.

0.0.130 - 28.10.2026 | 12:38 - Docs-only repository revision синхронизирует live frontend root/app `0.0.28`/`0.0.137` и immutable release после исправления независимого запуска online session при недоступном offline Service Worker. Зафиксирован read-only desktop/mobile acceptance 24/24 без mutation requests и runtime errors; deployed backend остаётся `0.0.128`, runtime-код и публичные контракты не менялись.

0.0.129 - 28.10.2026 | 12:25 - Docs-only repository revision фиксирует фактический rollout backend 0.0.128, clients-first порядок, schema v29/checksum, свежий pre-migration backup, health/invariant smoke и runtime APP_VERSION; исполняемый release и публичные контракты не менялись.

0.0.128 - 28.10.2026 | 11:35 - Все admin recipe moderation mutations закрыты server-side critical-confirmation gate до idempotency replay; fresh-PG acceptance проверяет missing/stale unlock proof, отсутствующее/истёкшее critical window и успешный valid replay.

0.0.127 - 28.10.2026 | 11:05 - Admin content получил независимые revision-aware оси review/publication с безопасным publicReason; добавлены contract/unit и fresh-PostgreSQL endpoint-проверки сценария active r1 + rejected r2.

0.0.126 - 28.10.2026 | 10:44 - Добавлен отдельный fresh-PostgreSQL acceptance для revision-aware recipe lifecycle: reject с сохранением старой публикации, replacement, оси review/publication, stale/downgrade/concurrent publish, безопасный publicReason, rollback с active-sibling guard, critical global hide и archive/restore без републикации.

0.0.125 - 28.10.2026 | 23:10 - Recipe moderation переведена на revision-aware lifecycle: moderator approve→publish, admin approve сразу публикует, replace/ reject/hide/unpublish/archive/critical-report сохраняют единый publication/case/reputation инвариант. Migration 029 добавляет recipe_id, compatibility backfill/trigger, composite FK и уникальность active publication/case; workspace DTO получает безопасные review/publication без внутренних заметок. Добавлены fresh и v28→v29 PostgreSQL acceptance, rollback несовместимых дублей, OpenAPI/docs/testing baseline v29.

0.0.124 - 27.10.2026 | 18:41 - Deployment/runbook приведён к фактическому тестовому стенду: зафиксированы immutable releases, canonical live/ready endpoints, schema v28, UFW, swap и проверенная chain runtime-ролей; добавлены воспроизводимые build/deploy/smoke/rollback/cleanup шаги без секретов. Удалены невыполнимые после разделения репозиториев команды production-readiness; runtime API, схема и данные не менялись.

0.0.123 - 27.10.2026 | 17:45 - Account-deletion revoked-role acceptance переиспользует отдельного резервного test-admin из content-domain fixture и выполняет revoke/restore/cleanup только в SERIALIZABLE транзакциях. Проверка соблюдает DB write-policy и инвариант последнего администратора; runtime API и схема не менялись.

0.0.122 - 27.10.2026 | 17:35 - Fresh PostgreSQL 18 acceptance исправляет тип контрольной выборки account-deletion review: UUID request id явно приводится к text перед сравнением с idempotency_records.target_binding. Endpoint/runtime API, схема и данные не изменились.

0.0.121 - 27.10.2026 | 17:24 - Fresh PostgreSQL 18 acceptance изолирует конкурентный account-deletion review/replay/conflict на отдельном тестовом remote address, чтобы общий Fastify rate-limit не маскировал ожидаемый idempotency conflict ответом 429. Runtime API, лимиты и схема не изменились.

0.0.120 - 27.10.2026 | 17:13 - Fresh PostgreSQL 18 acceptance учитывает уникальность staff-role на пользователя: временная резервная admin-role назначается отдельному test-user, а не действующему moderator. После проверки роль отзывается; runtime API и схема не изменились.

0.0.119 - 27.10.2026 | 17:04 - Fresh PostgreSQL 18 acceptance revocation-case теперь временно назначает резервного администратора и после восстановления основной роли отзывает его: проверка fresh admin-role больше не нарушает production-инвариант запрета удаления последнего активного администратора. Runtime API и схема не изменились.

0.0.118 - 27.10.2026 | 16:53 - Fresh PostgreSQL 18 acceptance выявил и закрыл least-privilege дефект content-workflow: роль meal_app теперь может читать только необходимое поле catalog_merges.preview для проверки version-bound not-duplicate решения. Добавлен source-regression; wire API, схема и миграции не изменились.

0.0.117 - 27.10.2026 | 16:29 - Catalog content-workflow закрывает stale merge и authorization TOCTOU без изменения wire API: обе карточки блокируются в стабильном порядке и повторно сверяются внутри serializable effect-транзакции, previewKey пересчитывается по актуальным данным, updates связаны с версиями, route target обязан входить в пару, а admin-role проверяется до replay/effect. Решение not-duplicate блокирует точную неупорядоченную пару версий до значимого изменения; acceptance покрывает stale/path/revoked-role/concurrent replay и единственность effect/audit/idempotency.

0.0.116 - 27.10.2026 | 15:49 - Для административного review удаления аккаунта добавлен обязательный UUID idempotencyKey и транзакционный actor-bound replay через meal.idempotency_records. Точный, в том числе конкурентный, повтор возвращает сохранённую deletion projection строго целевого request без второго review-step/audit даже при наличии более нового запроса пользователя; повтор ключа с другим payload отвечает 409. До replay/effect транзакционно перепроверяется актуальная admin-role, закрывая revoke TOCTOU. Повтор пользовательского deletion request при существующем `blocked` возвращает его projection без конфликтующей вставки. Сохранён осознанный повтор review с новым ключом и актуальной версией; OpenAPI и PostgreSQL acceptance обновлены.

0.0.115 - 27.10.2026 | 11:05 - Развёрнут тестовый production-стенд с systemd/Nginx/TLS/firewall, loopback API/PostgreSQL и отдельными frontend/admin origins; добавлен эксплуатационный runbook. Исправлена диагностика HTTP 500: серверный журнал теперь сохраняет безопасные технические поля исключения, не раскрывая их клиенту. Smoke подтвердил frontend login, admin password+MFA, dashboard и health; runtime роли БД задан `search_path=meal,public`.

0.0.114 - 26.10.2026 | 15:05 - Production-приёмка: PostgreSQL 18.6 acceptance исправлен для корректной последовательности доменов, разрешённого временного root и идемпотентного переиспользования обязательных единиц `pcs`/`g` на уже инициализированной базе; WAN/SSH-диагностика отделена от обязательных локальных latency/burst/heap gates; добавлены подробные руководства ручной проверки БД и backend/API, включая SQL/heap/pool/resource soak.

0.0.113 - 24.10.2026 | 19:29 - Инструкции запуска обновлены для трёх независимых проектов meal_backend, meal_frontend и meal_admin; сохранены API, origins и существующая baseline БД.

0.0.112 - 24.10.2026 | 19:16 - Добавлены только канонические справочники: 7 единиц измерения и 3 тарифных продукта, без demoaccounts и подписок. Явное транзакционное применение с проверкой конфликтов; повторное применение сохраняет IDs.

0.0.111 - 24.10.2026 | 18:20 - Backend выделен в самостоятельный репозиторий: локальные миграции, контракты, документация и команды проверки без зависимости на общий корень. Исправлены устаревшие SHA256 migration manifest для неизменённых SQL 003/006/007/008/010. Обновлены zod/Fastify/Nest и совместимые transitives: npm audit без уязвимостей. Тестовая PostgreSQL18 развёрнута, проверены grants, транзакционный rollback и восстановление backup в отдельную БД.

0.0.106 - 14.10.2026 | 15:21 - Account/account-lifecycle exact coverage повышено до 137 операций; добавлена migration 027, server-side export_not_ready, persisted blocked/audit и успешная delete-финализация после ready export и повторного review.

0.0.105 - 14.10.2026 | 16:20 - Admin operations inspect/preview/execute получили exact jobs/incidents lifecycle, replay/stale/concurrency и DB/audit assertions; route/body action mismatch теперь отклоняется до любого эффекта.

0.0.104 - 14.10.2026 | 15:30 - Admin billing view/command получили exact Plus/Pro gift lifecycle: critical gate, replay/conflict/stale, concurrency, entitlement/DB/audit readback и compensation AI на Pro; исправлены FOR UPDATE read-only каталога и append-only истории.

0.0.103 - 14.10.2026 | 14:53 - Exact live-PG acceptance добавлен для community feed/comments: фильтры, публичная проекция, cursor pagination, removed/missing/invalid states. Cursor сравнивает ту же миллисекундную точность, которую отдаёт Node, без повторов между страницами.

0.0.102 - 14.10.2026 | 14:00 - Exact live-PG acceptance добавлен для 8 finance и 3 pricing операций; исправлен 500 в update expense из-за неоднозначного SQL version, проверены replay/stale/readback и former-Pro read-only.

0.0.101 - 14.10.2026 | 13:00 - Все 8 support endpoints получили operation-specific live-PG lifecycle: meta/list/create/detail/edit/reply/close/reopen, owner isolation, fail-closed attachments, replay/conflict и exact DB effects; классификация 94 exact / 245 pending.

0.0.100 - 14.10.2026 | 12:45 - Products, recipes/bookmarks и unified search получили operation-specific live-PG success/effect/readback acceptance; классификация 86 exact / 253 pending, stores доступны application-role только на чтение.

0.0.99 - 14.10.2026 | 12:00 - Moderator decision API теперь отклоняет несовместимые со статусом действия, detail не предлагает actions без назначения текущему модератору; добавлен regression-набор таблицы переходов.

0.0.98 - 14.10.2026 | 11:05 - Live-PostgreSQL exact coverage дополнен user sessions/revoke-others, legal consent state/history, privacy state/update, own/update/public profile и front/admin telemetry с DB/readback/audit/isolation assertions. Добавлены минимальные profile-write grants, structured supplemental evidence и симметричная forced-GC heap-метрика; классификация 77 exact / 262 pending.

0.0.97 - 14.10.2026 | 07:58 - Exact live-PostgreSQL coverage расширен с 52 до 66 операций: закрыты admin/staff TOTP/recovery auth, Free-AI grant/view и notification preferences/list/read/read-all. Исправлены Free-AI response projection, notification UPDATE grant и strict notification response; backend 273/273 и fresh-PG smoke проходят.

0.0.95 - 14.10.2026 | 05:46 - PostgreSQL acceptance-runner теперь сохраняет `results.json` через локальный Prettier и немедленно проверяет его exit code, поэтому versioned I1/I2/I3 evidence входит в штатный backend lint; три свежие итерации повторены на этой версии.

0.0.94 - 14.10.2026 | 05:37 - Зафиксированы три свежие PG18.6 acceptance-итерации в versioned JSON/log evidence; Inventory 8/8 operationId подтверждены success/readback/replay/stale rollback/effects, классификация 347 операций проходит в общем наборе 273/273.

0.0.93 - 14.10.2026 | 06:10 - InventoryController получил operation-specific live-PostgreSQL acceptance всех 8 operationId и command/location веток с readback, replay, stale/rollback и DB effects; добавлены полная классификация 347 операций и сохраняемые I1/I2/I3 evidence-пакеты.

0.0.92 - 14.10.2026 | 05:24 - Актуальный PostgreSQL acceptance report синхронизирован со схемой v26: миграции 001–026, 209 таблиц/482 FK, тарифные/consent/moderator границы, 347-operation defensive sweep и 10,000-row performance/lock baseline.

0.0.91 - 14.10.2026 | 01:01 - Fresh-PG acceptance теперь в каждой итерации создаёт 10,000 связанных inventory batches, измеряет list/search p50/p95/p99, сохраняет `EXPLAIN ANALYZE` list/search/count и проверяет lock timeout `55P03` с точным retry recovery. Три чистые итерации PASS.

0.0.90 - 14.10.2026 | 00:18 - Moderator reject теперь сохраняет terminal status `rejected`, поэтому отклонённый case не остаётся активным в queue/SLA; fresh-PG acceptance расширен конкурентным claim двух модераторов и всеми decision actions.

0.0.89 - 13.10.2026 | 23:07 - Fresh-PG acceptance получил локальные performance guardrails: p50/p95/p99 health/entitlement/former-Pro/admin, 40-request pool burst, bounded heap growth и deterministic global rate-limit 429 на запросе 201. Три итоговые итерации PASS.

0.0.88 - 13.10.2026 | 22:55 - Fresh-PG moderator acceptance расширен реальными moderation cases: stale-version, claim/exact replay, changed replay, approve/exact replay, skip и точные claims/decisions/idempotency/audit/release effects. Owner-соединение ограничено подготовкой billing/media fixtures; приложение работает только под meal_app. Три итерации PASS.

0.0.87 - 13.10.2026 | 22:43 - Live moderator acceptance получил stateful support ticket: detail, reply, exact idempotent replay без дубля, changed replay 409, reopen и точные counts для messages/events/idempotency/audit. Три fresh-PG итерации повторены успешно.

0.0.86 - 13.10.2026 | 22:14 - Fresh-PG acceptance расширен реальными Free→Plus trial→Pro→former-Pro переходами, family active/blocked, special-category revoke/regrant, шестью moderator queues с отзывом grant/role, 22 admin reads с session/unlock, 213 role-aware mutations и раздельными logout. Три финальные итерации PASS, временные runtime удалены.

0.0.85 - 13.10.2026 | 21:33 - HTTP gate расширен до 1 269 defensive-запросов; self-cleaning runner трижды проверяет fresh PG18, 132 authenticated GET и 214 mutation boundaries. Устранены четыре DB-only 500 и недокументированный multipart 406, нормализованный в 415; добавлен regression-test.

0.0.84 - 13.10.2026 | 20:55 - Добавлен исполняемый HTTP coverage-gate для всех 347 OpenAPI operations: live Fastify registration, безопасный unauthenticated request, только документированные статусы, строгий error envelope, обязательные request ID/no-store и запрет 500/501.

0.0.83 - 13.10.2026 | 15:03 - Acceptance runtime в штатном back/.local исключён из ESLint и Prettier, чтобы live PostgreSQL из runbook не ломал проверки исходного кода.

0.0.80 - 12.10.2026 | 18:34 - Legal gate требует независимые approval references и умеет offline-проверять будущий evidence-файл против текущего release tuple; account deletion теперь отзывает password/tokens/MFA/critical/staff access. OpenAPI 0.0.59 без изменений.

0.0.79 - 12.10.2026 | 17:28 - OpenAPI 0.0.59: first-party telemetry пишет безопасные browser/backend/provider/worker события в админку; workers получили PostgreSQL lease/fencing, schema v24 (205/476), backup contract v3 и readiness scaffolds без применения БД.

0.0.78 - 10.12.2026 | 16:19 - PostgreSQL 18 clean-bootstrap исправлен и трижды подтверждён на live DB: атомарные migrations 001–023, 204 таблицы/476 FK, ограниченная meal_app, v22 grants, readiness v23, recovery evidence v2 и реальный account lifecycle; OpenAPI 0.0.58 без изменений.

0.0.77 - 10.09.2026 | 15:29 - OpenAPI 0.0.58 без изменений: strict legal release evidence, approval/surface/consent binding и offline fail-closed gate.

0.0.76 - 10.09.2026 | 15:11 - OpenAPI 0.0.58 без изменений: worker lease/run health, backup/restore evidence, read-only production acceptance и offline readiness gates.

0.0.75 - 10.09.2026 | 14:58 - OpenAPI 0.0.58 без изменений: versioned nine-task worker topology, bounded one-shot planner и read-only deployment manifest.

0.0.74 - 10.09.2026 | 13:54 - OpenAPI 0.0.58 без изменений: provider-neutral secret references/material, strict provider telemetry и observer с fail-safe delivery.

0.0.73 - 10.09.2026 | 13:45 - OpenAPI 0.0.58 без изменений: provider-neutral durable OCR port, ready/clean/encrypted gate, provider/mode/source/checksum binding, versioned external consent и mandatory review.

0.0.72 - 10.09.2026 | 13:35 - OpenAPI 0.0.58 без изменений: provider-neutral email/Web Push ports, delivery state/binding/webhook policies, quiet-hours/consent gate и два registered fail-closed providers.

0.0.71 - 10.09.2026 | 13:09 - OpenAPI 0.0.58 без изменений: provider-neutral storage/KMS/scanner ports, quarantine lifecycle, binding/TTL policies и три зарегистрированных fail-closed provider-а; PostgreSQL не менялась.

0.0.70 - 10.09.2026 | 12:59 - OpenAPI 0.0.58 без изменений: provider-neutral payment port, state/binding/webhook policies и зарегистрированный disabled provider; provider/merchant остаются real-data TODO.

0.0.69 - 10.09.2026 | 12:46 - OpenAPI 0.0.58 без изменений: `AiProvider` переведён на OpenAI Responses API, reasoning low, `store=false`, строгий `output_text` parsing и fail-closed provider errors.

0.0.68 - 10.09.2026 | 12:25 - OpenAPI 0.0.58: preview/commit для платного lifecycle Plus/Pro, пропорциональный upgrade, renewal, downgrade, promo и Combine; PostgreSQL/grants не применялись.

0.0.67 - 10.09.2026 | 11:42 - OpenAPI 0.0.57: Pro export domains/formats, versioned manifest, entitlement cutoff, ACL recheck на enqueue/worker/download и former-Pro history.

0.0.66 - 10.09.2026 | 10:58 - OpenAPI 0.0.56: `ai-task-policy-v2`, immutable context/priority/budget preview, 18 задач и подготовленная migration 023 без применения PostgreSQL.

0.0.65 - 10.08.2026 | 18:45 - OpenAPI 0.0.55: Pro deterministic plan optimization, explicit priority order, candidate assessments, honest coverage и stale-safe commit.

0.0.64 - 10.08.2026 | 18:20 - OpenAPI 0.0.54: `view=calendar` проецирует выбранный месяц и требует отдельную Pro calendar capability.

0.0.63 - 10.08.2026 | 18:05 - OpenAPI 0.0.53: private financial analytics по периоду/категории, receipt/store metrics, savings coverage и nullable forecast при недостаточной истории.

0.0.62 - 10.08.2026 | 17:07 - OpenAPI 0.0.52: Pro electronic receipts, exact financial lines, fiscal metadata, active-Pro gate и receipt-linked private expenses/price observations; PDF/OCR fail closed, PostgreSQL не применялась.

0.0.61 - 10.08.2026 | 16:38 - OpenAPI 0.0.51: private price observations с consent/provenance, read-only system medians и approximate recipe/list/plan estimates с honest incomplete totals; grants подготовлены, PostgreSQL не применялась.

0.0.60 - 10.08.2026 | 15:42 - OpenAPI 0.0.50: private manual finance expenses и overall budgets с RUB minor units, explicit consent, idempotency, optimistic versions, audit и former-Pro read-only; grants подготовлены, PostgreSQL не применялась.

0.0.59 - 10.08.2026 | 11:25 - OpenAPI 0.0.49: nutrition settings/profile/targets/analytics, append-only target periods, honest-null completeness/progress, optimistic concurrency/idempotency/audit и former-Pro cutoff без миграций.

0.0.58 - 10.08.2026 | 10:24 - OpenAPI 0.0.48: portion proposal→private diary sync, manual/24h timeout, former-Pro late cancel, CAS/audit/runner и fail-closed media boundary без миграций.

0.0.57 - 10.07.2026 | 20:13 - Private diary day/sources/create/update/archive, immutable snapshots, atomic personal inventory debit, idempotency, audit, optimistic versions and reusable Pro access boundary; OpenAPI 0.0.47.

0.0.56 - 07.10.2026 | 19:21 - OpenAPI 0.0.46: добавлен `GET /api/v1/pro/overview` с активным и former-Pro read-only доступом, фактическими целями/счётчиками/AI-квотами и запретом выдуманных значений; PostgreSQL не изменялась.

0.0.55 - 07.10.2026 | 18:29 - Исправлены статистика готовки, полный total поддержки, sanction-before-replay, авторизация content releases, TOCTOU rollback, worker claimed count и подсчёт публикаций; подготовлены migration 022 и runner будущей передачи семейной Plus.

0.0.54 - 06.10.2026 | 14:20 - Явный registry доменных compensator-ов: content release, moderation, sanction и recipe-policy; critical/CAS/preview/idempotency/audit, неизвестные операции fail closed.

0.0.53 - 06.10.2026 | 14:03 - PostgreSQL admin billing для Plus grant/extend/revoke/freeze/unfreeze и legal/compensation review read+preview; refund/export/generic rollback fail closed.

0.0.52 - 06.10.2026 | 13:41 - Исправлены blocker-запросы удаления аккаунта на `subscriptions.owner_id` и `billing_orders.payer_id/recipient_id`; контракт не менялся.

0.0.51 - 06.10.2026 | 13:20 - Отдельный moderator API с MFA/role/grant проверками, claim/skip, решениями и безопасной поддержкой; OpenAPI 0.0.45.

## 0.0.50 — 6 октября 2026

OpenAPI 0.0.44: content-release registry расширен строго типизированными `content_document` и `dictionary_entry`. Оба адаптера поддерживают create/update/retire, validation, canonical heads, атомарные publish/rollback и edit-from-current; sources API возвращает их проекции. Неизвестные namespace/dictionary/schemaVersion fail closed, realtime moderation/allergen mappings/news не менялись. Подготовлена migration 021/readiness v21 (203 таблицы/474 FK), PostgreSQL не применялась.

## 0.0.49 — 6 октября 2026

OpenAPI остаётся 0.0.43: новых HTTP-операций нет. In-app новости можно безопасно планировать; bounded runner
публикует наступившие записи под `SKIP LOCKED` и создаёт уведомления с устойчивым dedup key. Истёкший ignore
инцидентов теперь сохраняемо возвращается в `new` с системным аудитом. Retention entrypoint-ы для ошибок, метрик и
file metadata работают только как policy-aware dry run и ничего не удаляют. Регистрация получила отключённую по
умолчанию provider-neutral risk/CAPTCHA/disposable-email policy с явными fail-open/fail-closed режимами. Порог
публикации статистики готовки вынесен в versioned rule `cooking_statistics_publication`, builtin v1 = 3. Новых
миграций нет; PostgreSQL, внешние провайдеры и scheduler не подключались.

## 0.0.48 — 6 октября 2026

OpenAPI 0.0.43: manifest-based личный/семейный экспорт с server ACL snapshot, одноразовый user critical reauth, архивирование и request/cancel/admin approve/reject/finalize жизненного цикла удаления. Export и retention runners доступны только как ручные entry points; storage, scheduler и policy values не подключены и fail-closed. PIN trust по умолчанию 30 дней. Подготовлена migration 020/readiness v20 (203 таблицы/474 FK), PostgreSQL не применялась.

## 0.0.47 — 6 октября 2026

Добавлен aggregate evaluator всех 60 согласованных достижений с идемпотентной выдачей по стабильному коду и lazy backfill исторических данных. Admin moderation получил канонический transition содержательной catalog correction: принятие начисляет +2 репутации, отмена создаёт точный append-only reversal, повторные переходы сохраняют auditable compensation chain. Публичный OpenAPI остаётся 0.0.42; migration 019/checksum обновлены, PostgreSQL не применялась, тесты не запускались.

## 0.0.46 — 6 октября 2026

Добавлены публичные достижения и числовая репутация с 10 release-managed званиями. Контент-релизы хранят серверный draft, typed patches, version/idempotency и точный client checksum ack; publish/rollback атомарны, требуют critical reauth и сохраняют immutable snapshots. Rollback возвращает релиз в draft, edit-from-current создаёт новую ревизию из актуальных canonical heads. Подготовлена migration 019/readiness v19 (201 таблица/470 FK); PostgreSQL не изменялась. OpenAPI 0.0.42; tests/browser QA не запускались.

## 0.0.45 — 6 октября 2026

Добавлены публичные community/news/search read-модели, подписки на авторов, приватность AI, история/архив AI, формальные AI-апелляции, безопасные preview экспорта, деталь жалобы и добровольная передача владения семьёй без срока. Admin news получил versioned draft/preview/in-app publish/cancel/test и аудит чтения; email/push/scheduler/export generation fail-closed. Подготовлена migration 018 и readiness v18 (194 таблицы/457 FK), PostgreSQL не изменялась. OpenAPI 0.0.41; tests/browser QA не запускались.

## 0.0.44 — 5 октября 2026

Добавлен отдельный allergen intelligence: универсальные versioned mappings ingredient/variant/SKU, typed admin subject selector, recipe projection с icon/evidence/unknown groups, пользовательский report-to-support и admin lifecycle mappings/fallback icons. Upload честно недоступен до storage/scanner. Migrations 016/017 зарегистрированы в manifest/readiness v17 (192 таблицы/452 FK), grants подготовлены, PostgreSQL не изменялась. OpenAPI 0.0.40; tests/browser QA не запускались.

## 0.0.43 — 5 октября 2026

Рекомендации вынесены в отдельный `recommendations` module: типизированные recipe/author candidates, детерминированный `personalized-v1`, reasons/safety warnings, diversity, collaborative thresholds, события выдачи и desired-state follow/unfollow. Подготовлены migration 016 и least-privilege grants, но PostgreSQL не изменялась. OpenAPI 0.0.38; tests/browser QA не запускались по действующему решению.

## 0.0.42 — 5 октября 2026

Добавлено пользовательское управление подпиской: read model текущего тарифа и AI-балансов, одноразовый 7-дневный Pro trial с 10 AI-действиями, simulation preview/commit для Plus на месяц или год и запланированное понижение в Free после оплаченного периода. Команды защищены версиями, идемпотентностью и транзакционным аудитом; подготовленные application grants дополнены для новых таблиц и `users.version`. OpenAPI 0.0.37; PostgreSQL и миграции не изменялись, реальные списания отсутствуют, тесты по действующему решению не запускались.

## 0.0.41 — 5 октября 2026

Версия синхронизирована с frontend-итерацией семейной области по умолчанию. Backend-контракты и OpenAPI 0.0.36 не менялись; PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-family-scope-iteration.md.

## 0.0.40 — 5 октября 2026

Preview и подтверждение вступления/выхода из семьи перераспределяют только свободный остаток семейной подписочной AI-квоты; исключение участника использует тот же транзакционный расчёт. Потраченные, зарезервированные и переданные действия не отзываются, изменения аудируются в `ai_ledger`. OpenAPI 0.0.36. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-redistribution-iteration.md.

## 0.0.39 — 5 октября 2026

Добавлена подтверждаемая донором передача AI-действий между участниками семьи после исчерпания доли: идемпотентность, version guard, ledger-аудит и срок до конца периода. OpenAPI 0.0.35. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-transfer-iteration.md.

## 0.0.38 — 5 октября 2026

Семейный AI-резерв Plus включён в баланс действующего участника, но расходуется только после отдельного подтверждения конкретного запуска или нового платного интервала. Согласие аудируется в `ai_reserve_consents`; OpenAPI 0.0.34. PostgreSQL не изменялась, тесты не запускались. Подробности: ../docs/plus-ai-reserve-iteration.md.

## 0.0.37 — 1 октября 2026

Завершён согласованный Plus-срез: полный lifecycle семейных приглашений, семейные заготовки и QR, базовый подбор рецептов по личным/семейным запасам, месячные AI-квоты и административное управление семьями и передачей Plus при бане. OpenAPI 0.0.33; migration v15 и grants только подготовлены, SQL не применялся. Объединение Plus в Pro остаётся этапом Pro.

## 0.0.36 — 1 октября 2026

Умные списки и длинные горизонты планирования ограничены Plus/Pro. Добавлены preview/commit еженедельного повторения выбранного рецепта, расчёт реальных 52/53 дат, пропуск занятых слотов без перезаписи и сохранение правила в `plan_rules`. OpenAPI 0.0.32; схема остаётся v14, SQL не применялся.

## 0.0.35 — 1 октября 2026

Добавлены версионируемые QR-этикетки личных заготовок для Plus/Pro: entitlement, идемпотентный выпуск, отзыв прежней версии, безопасный offline payload, аудит и подготовленный grant. OpenAPI 0.0.31; схема остаётся v14, SQL не применялся.

## 0.0.34 — 1 октября 2026

Добавлен семейный чат: доступ с даты вступления, поиск, replies, активные mentions, авторские edit/tombstone, личное скрытие, реакции, закрепления, черновик и read receipt. OpenAPI 0.0.30. Подготовлена migration 014 и схема v14; SQL не применялся.

## 0.0.33 — 1 октября 2026

Добавлены семейные текстовые заметки и чек-листы: авторские изменения, совместные отметки, архив, immutable-ревизии, аудит, optimistic concurrency и идемпотентность. OpenAPI 0.0.29; схема v13 не менялась, application grants только подготовлены, SQL не применялся.

## 0.0.32 — 1 октября 2026

Семейный план поддерживает диапазон до 366 дней и распределение порций по активным участникам. Добавлены назначение prepared-еды, немедленное списание, 24-часовое автоподтверждение и отмена без возврата остатка. OpenAPI 0.0.28; схема v13 не менялась, SQL не применялся.

## 0.0.31 — 1 октября 2026

Shopping, receipt и purchase workflows поддерживают private/family scope, повторную проверку семейного доступа, scope-bound идемпотентность и аудит действий списка. OpenAPI 0.0.27; схема v13 уже содержит нужные связи, SQL не применялся. Backend-набор — 132/132.

## 0.0.30 — 1 октября 2026

Recipe workspace поддерживает private/family scope, семейное чтение при действующем покрытии и авторские mutations без передачи владения рецептом. OpenAPI 0.0.26; схема остаётся v13, SQL не применялся. Backend-набор — 132/132.

## 0.0.29 — 1 октября 2026

Inventory API поддерживает строго разделённые private/family scope с повторной проверкой членства и покрытия, общими семейными партиями, местами и историей. OpenAPI 0.0.25; схема остаётся v13, SQL не применялся.

## 0.0.28 — 1 октября 2026

Вторая итерация Plus: выход и исключение участника, обязательная ручная/автоматическая передача владения, архивная история членства и полноэкранное уведомление преемника. OpenAPI 0.0.24; схема v13 не менялась, application grants только подготовлены. PostgreSQL не изменялась; 130 тестов.

## 0.0.27 — 1 октября 2026

Первая итерация Plus: единый entitlement service, `GET /entitlements`, семейный context/create API, строгие DTO, аудит, идемпотентность и защита конкурентного создания. OpenAPI 0.0.23; схема остаётся подготовленной v13, добавлены только application grants. PostgreSQL не изменялась и миграции не применялись.

## 0.0.26 — 1 октября 2026

OpenAPI 0.0.22: Free-admin workspace санкций/прав, текстовой поддержки, модерации/каталога и безопасных операций переведены с 503-заглушек на PostgreSQL-адаптеры. Подготовлена, но не применена migration 013 для обязательной категории санкции и приватной staff-заметки; целевая схема v13 остаётся 186 таблиц/436 FK. Вложения поддержки fail closed до object storage и медиасканера; произвольные и финансовые background jobs не запускаются.

## 0.0.25 — 1 октября 2026

OpenAPI 0.0.21: добавлены реальные admin-endpoint’ы просмотра и критичной идемпотентной выдачи Free AI-квоты, а также PostgreSQL-адаптер центра admin-уведомлений. Подготовлена, но не применена миграция 012 для настроек уведомлений и lifecycle инцидентов; целевая схема v12 — 186 таблиц/436 FK. Карточка пользователя больше не смешивает Free-операции с Plus/Pro billing. Backend-набор — 123/123.

## 0.0.24 — 30 сентября 2026

OpenAPI 0.0.20: AI-беседы получили постоянное чтение и продолжение, два включённых уточнения в фиксированном 10-минутном интервале, ожидание третьего и новый reserve/capture после границы без повторного preview. Добавлены доменные проверки интервала; полный backend-набор — 121/121. Схема остаётся подготовленной v11, PostgreSQL не менялась. Единый список внешних работ: free-tier-todo.md.

## 0.0.23 — 30 сентября 2026

Добавлен выключенный по умолчанию AI reconciliation worker: раз в минуту он освобождает append-only ledger-резерв операций, оставшихся processing более 15 минут, и фиксирует `refunded/process_interrupted`. Проход ограничен 100 операциями, не перекрывается и безопасен при нескольких backend-инстансах. Схема остаётся подготовленной v11; PostgreSQL не менялась, тесты не запускались.

## 0.0.22 — 30 сентября 2026

OpenAPI 0.0.19: AI preview/run доведены до серверной orchestration — снимок согласия, 10-минутный preview, идемпотентный резерв, provider call вне транзакции, атомарные capture/release и точный `refunded` при сбое. Подготовлены migration 011 с immutable cost rule, readiness v11 и минимальные grants; PostgreSQL не менялась. Покупка и reconciliation worker ещё отключены. Тесты не запускались. Подробности: ai.md.

## 0.0.21 — 30 сентября 2026

OpenAPI 0.0.18: AI capabilities, buckets, history, preview/run и test-package contracts; изолированный OpenAI-compatible provider config. Реальное выполнение и покупка fail closed до orchestration/payment adapter. Схема v10 не менялась, миграции не применялись, тесты не запускались. Подробности: ai.md.

## 0.0.20 — 30 сентября 2026

OpenAPI 0.0.17: пользовательские обращения, очереди, переписка, optimistic version/idempotency, редактирование собственного сообщения с закрытой историей, закрытие и возобновление. Использована существующая схема v10; миграции не создавались и не применялись. Реальная загрузка вложений отключена до хранилища и сканера. Тесты не добавлялись и не запускались. Подробности: support.md.

## 0.0.19 — 30 сентября 2026

OpenAPI 0.0.16: пользовательский центр уведомлений, безопасная проекция payload, category/unread pagination, versioned read/read-all и настройки Web Push/email/quiet hours/plan reminder. Внешняя доставка остаётся отключённой. Существующая схема v10 не менялась, миграции не применялись, тесты не добавлялись и не запускались. Подробности: notifications.md.

## 0.0.18 — 30 сентября 2026

OpenAPI 0.0.15: агрегированная личная главная, persisted онбординг 3/5/7 шагов, пищевые предпочтения и редактирование собственного профиля с optimistic version/idempotency. Используется существующая схема v10; миграции не создавались и не применялись. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: personalization.md.

## 0.0.17 — 30 сентября 2026

OpenAPI 0.0.14: прогресс готовки принимает фактическое UTC-время `occurredAt`, чтобы offline-таймеры синхронизировались без сдвига к моменту подключения. Допустимое окно — не старше 30 дней и не более пяти минут в будущем. Схема PostgreSQL не менялась, миграции не применялись, тесты не добавлялись и не запускались.

## 0.0.16 — 30 сентября 2026

Личный план питания Free: день/неделя, ручные слоты, preview/commit, immutable revisions, мягкие резервы и отдельное подтверждение списка покупок. OpenAPI 0.0.13. Схема остаётся подготовленной v10; обновлены только application grants, PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: meal-plan.md.

## 0.0.15 — 30 сентября 2026

Полный онлайн-срез личных покупок и фото-чеков Free: lifecycle и порядок списков, purchase preview/commit, частичная покупка и избыток, receipt review/duplicate link, однократное поступление и позднее уточнение неизвестного количества. OpenAPI 0.0.12. Подготовлена миграция 010 и readiness v10 (184 таблицы/433 FK); PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались.

## 0.0.14 — 29 сентября 2026

Личные заготовки Free: физические банки, неизвестные остатки, preview и атомарный расход, открытие, архив/история, связь с рецептами и расход при готовке. OpenAPI 0.0.11. Подготовлена миграция 009 и readiness v9 (184 таблицы/431 FK); PostgreSQL не менялась. Тесты по поручению пользователя не добавлялись и не запускались. Подробности: preserves.md и общая итерация.

## 0.0.13 — 29 сентября 2026

Незавершённая готовка: напоминания 2/4 дня, тихие часы 22:00–09:00 локально, архив на шестой день и скрытие через календарный месяц. Пользовательские настройки, внутренние уведомления, фоновая обработка под явным флагом. OpenAPI 0.0.10; схема v8 не меняется, grants подготовлены. По поручению пользователя тесты не добавлялись и не запускались.

## 0.0.12 — 29 сентября 2026

Личный авторинг/версии/модерация, сообщество, готовка и атомарный расход/выход, ручные покупки, общие лимиты с аудитом. OpenAPI 0.0.9. Подготовлена 008, readiness v8; защищён наполняемый production-каталог. БД не менялась. Границы и проверки: ../docs/recipe-workflows-iteration.md.

## 0.0.11 — 29 сентября2026

Recipes list/public detail/personal availability/bookmark, опубликованная revision вместо draft, фильтрация/сортировка до пагинации и отдельный приватный ответ. OpenAPI0.0.8; подготовлена007_recipe_catalog.sql, readinessv7,181таблица/428FK без новых таблиц/FK. РекомендацииTODO; write-рецептов/готовки/покупок нет. PostgreSQL не менялась; результаты финальных проверок фиксируются отдельно.

## 0.0.10 — 28 сентября 2026

Free: личные inventory SQL-команды, места/история/идемпотентность, каталог и собственные pending-предложения, multipart/OCR/табличный импорт с проверкой перед атомарным commit. OpenAPI0.0.7; подготовлена006 metadata партии (181 таблица/428 FK без новых таблиц/FK). Локальные OCR-модели и независимый Linux-перенос. PostgreSQL не менялась, административные workspace503 остаются без persistence. Проверки 28 сентября 2026: back — 74 теста; front — 44 теста; frontend_admin — 81 тест. TypeScript, ESLint, Prettier, CSS lint, генерация контрактов и production-сборки прошли. Дополнительно 13 браузерных сценариев: локальный OCR, EAN13 с изображения, CSV/XLSX/ODS, ручные операции, конфликт двух вкладок, приватность pending-предложения и мобильные страницы. PostgreSQL-интеграция и Linux OCR требуют проверки после отдельно согласованного переноса.

## 0.0.9 — 28 сентября 2026

OpenAPI0.0.6 и защищённые workspace-контроллеры governance/billing/support/content/news/notifications/operations/review для интерфейса административных моков. Новые контроллеры явно возвращают503: production persistence, worker и провайдеры ещё не подключены. Подготовленная SQLv5 не менялась и не применялась; проверки текущего среза фиксируются после завершения прогонов. Матрица: ../docs/admin-ui-readiness.md.

## 0.0.8 — 28 сентября 2026

Добавлена опциональная конфигурация ADMIN_ALLOWED_IPS и глобальная серверная проверка административных маршрутов. Пустой список не ограничивает IP, заполненный допускает только точные IPv4/IPv6. Добавлены проверки подмены forwarded-заголовков, доверенного proxy, IPv6 и сохранения авторизации. Контракт DTO/SQL не менялся; env и инфраструктура не менялись. Инструкция: docs/admin-network.md.

## 0.0.7 — 28 сентября 2026

Основа возвратов и изолированный mock-провайдер: целые суммы, остаток с учётом резервов, идемпотентность и неопределённый исход. Зафиксированы два режима последствий и отложенное подключение оплаты. HTTP/UI и persistence возвратов ещё не подключены; OpenAPI0.0.5 и SQL001–005 не менялись. Проверки и ограничения — docs/payments.md.

## 0.0.6 — 28 сентября 2026

Административный вход по username, отдельная семидневная сессия с доказательством разблокировки вкладки, повторный TOTP и 30-минутное подтверждение критичных действий без пароля. OpenAPI0.0.5. Подготовлена SQL005 и переносv5 (181 таблица/428 FK), без применения. Обычный и moderator auth не менялись; неизвестные критичные команды не включены.

## 0.0.5 — 28 сентября 2026

Изолированный admin/auth, read-проекции16 разделов, согласованные команды поддержки и настройки уведомлений, OpenAPI0.0.4. Подготовлены telemetrySQL004, типы/grants и переносv4 (180 таблиц/427 FK). Критичные неуточнённые команды недоступны. Live БД не менялась; ограничения в docs/admin-read.md.

## 0.0.1 — 25 сентября 2026

Первичная инициализация отдельного backend: NestJS/Fastify/TypeScript, pg/Kysely, единый API и OpenAPI, health, env-валидация, безопасные логи, shutdown, сессии и CSRF, обычный и служебный вход с TOTP/резервными кодами. Добавлены типы схемы, additive SQL 002, план provisioning, собственные линтеры, тесты и CI для общего и будущего отдельного репозитория.

Автономные проверки выполнены; SQL 002 и роль приложения не применены. Проверки PostgreSQL, конкурентного MFA и переноса на Linux остаются открытыми. Версия корневого проекта-рыбы не наследуется. Следующие повышения — только patch.

## 0.0.2 — 25 сентября 2026

Миграции отложены до переноса, добавлены runbook и общая инструкция агента; подготовлены общие HTTP-сценарии для backend и mock. Wire-contract остаётся 0.0.1. PostgreSQL не изменялась; подробности в backend-version-list.md.

## 0.0.3 — 28 сентября 2026

Добавлены GET own/public профилей, строгие DTO и синхронизированные моки, OpenAPI 0.0.2. Front включает страницы профилей, страницу сессий аккаунта и Arc loading-компоненты. Новые тесты приватности, fallback, параметров URL и браузерных состояний. Auth lifecycle ожидает решений пользователя; БД не менялась.

## 0.0.4 — 28 сентября 2026

Account lifecycle, TOTP ordinary login/PIN, управление фактором и резервными кодами, dev-only mailbox, OpenAPI0.0.3. Подготовлены v3 и least-privilege grants, реальная PostgreSQL не менялась. docs/account.md фиксирует границы production и обязательную будущую приёмку.

0.0.107 - 10.14.2026 | 18:15 - Exact live-PG acceptance расширен до 277/347 операций: recipe workspace, family, commerce, cooking/meal-plan/preserves и 37 admin operations; исправлены подтверждённые projection/grant/CAS/jsonb defects. Подготовлен, но не классифицирован незавершённый 32-operation AI/Pro модуль; runtime удалён.

0.0.108 - 10.15.2026 | 18:59 - Exact live-PG классификация завершена: 339 локально исполнимых операций PASS 3×, 5 provider-bound fail-closed и 3 external AI success остаются BLOCKED. Migration 028 и query-оптимизации сокращают shopping 201→1 SQL, family notes 3203→16 строк и исправляют moderator queue correctness/performance; временный PG runtime удалён.
0.0.109 - 10.20.2026 | 21:42 - Синхронизирован least-privilege regression для user_settings с уже действующим точным grant набора timezone/locale/theme/onboarding_state/preferences/version. Backend secrets/generated-types/type/lint/format/build и полный test runner 280/280 PASS; публичные API и SQL grants не изменялись.

0.0.110 - 10.22.2026 | 13:47 - Backend-документация сведена к README, AGENTS и четырём эксплуатационным runbook; удалены устаревшие доменные срезы и дубли журналов без изменения API, runtime и миграций.
0.0.152 - 10.29.2026 | 18:16 - Deploy-helper теперь извлекает APP_VERSION из package.json immutable backend image, сохраняет её вместе с digest в root-owned images.env и корректно восстанавливает version metadata и backend/worker/mail-worker при rollback; устранён подтверждённый drift live APP_VERSION 0.0.135 при коде 0.0.151.

0.0.151 - 10.29.2026 | 18:00 - Добавлена fail-closed транзакционная account-mail подсистема без изменения публичного HTTP API: migration 031 создаёт atomic PostgreSQL outbox и append-only attempts, legacy MFA-key tokens безопасно отзываются, новые tokens используют отдельный ACCOUNT_MAIL_TOKEN_KEY. Отдельный least-privilege mail-worker получил lease/CAS two-worker safety, bounded retry/backoff, terminal unknown для неоднозначной SMTP acceptance, deterministic Message-ID, verified TLS/timeouts и четыре allowlisted шаблона; opt-in hardened Compose, grants, recovery contract v6/schema v31, runbook и regression tests синхронизированы. Реальный SMTP не подключался.

0.0.153 - 10.29.2026 | 18:37 - Production tracker синхронизирован с фактически развёрнутыми backend 0.0.152, admin 0.0.128, frontend 0.0.152 и schema v31. Транзакционная почта отмечена как технически подготовленная и ожидающая SMTP/DNS owner inputs; storage/scanner checkpoint честно переведён в согласование после полного contract audit и подтверждения недостаточной RAM для production-safe ClamAV. Runtime, HTTP API и DB schema не изменялись.

0.0.154 - 11.02.2026 | 09:19 - Подготовлен fail-closed фундамент encrypted media storage: provider-neutral S3 env/secrets, purpose policies, application-side AES-256-GCM с AAD-привязкой и plaintext checksum, owner-bound upload/download tokens, atomic CAS claim и reconciliation-safe lifecycle для неизвестных PUT/COMMIT, schema v32 с quarantine reservations/bindings/least-privilege grants, OpenAPI 0.0.62 и эксплуатационный runbook. Строгий `LEGAL_EVIDENCE_MODE=approved|demonstration` подключён к manifest, регистрации и consent gates: default `approved` не откатывается на заглушки, явный test-mode принимает только точные immutable demonstration refs. Добавлена operator-only dry-run команда восстановления TOTP: execute требует отдельный env-gate и точное подтверждение login, атомарно отзывает factors/challenges/sessions, пишет обезличенный audit и выполняет zero-active readback. S3 adapter, scanner, reconciler, публикация, применение миграции/VPS и фактический MFA reset намеренно не включены до отдельных согласований.

0.0.155 - 11.02.2026 | 10:25 - Исправлена production-упаковка operator-only MFA recovery: CLI теперь входит в immutable runtime image и запускается поверх уже собранного `dist` без dev-зависимостей и повторной сборки. Production Compose явно передаёт согласованный legal evidence mode и жёстко оставляет media storage выключенным. Backend rollout теперь останавливает writers до финального проверенного backup, исключая RPO-разрыв перед миграцией; добавлены deployment invariants и уточнён VPS runbook. HTTP API и schema v32 не изменены.

0.0.156 - 11.02.2026 | 12:10 - Реализован checkpoint 6A encrypted local storage без включения пользовательских загрузок: добавлен S3-compatible AWS SDK adapter с sanitized preflight и reconciliation-safe outcome classification, отдельный hardened SeaweedFS overlay без host ports, независимые infrastructure/API feature gates, root-owned bootstrap/secrets, disk guard и evidence-only reconciliation planner без автоматического удаления. Production rollout сохраняет `MEDIA_STORAGE_ENABLED=false`; generic reservations остаются fail-closed до target binding, quotas и scanner/manual-review policy. OpenAPI 0.0.62 и schema v32 не изменены; media пока исключено из backup и считается disposable test data.

0.0.157 - 11.02.2026 | 12:48 - Исправлен production bootstrap SeaweedFS: непривилегированный provider UID/GID 29003 получает только групповое чтение своей S3 identity-конфигурации через `root:meal-media 0440`. Добавлена узкая идемпотентная миграция прежнего безопасного файла `root:root 0400` и regression-проверка; остальные storage/backend secrets, пользовательский media API, OpenAPI и schema v32 не изменены.

0.0.158 - 11.02.2026 | 12:55 - Адаптированы SeaweedFS healthcheck и private-bucket provisioning к CLI 4.51: удалён устаревший флаг `weed shell -command`, команды передаются через поддерживаемый stdin с проверкой кластера до создания бакетов. Добавлены deployment regressions на новый вызов и запрет legacy-флага; пользовательский media API остаётся выключенным, публичные контракты и schema v32 не менялись.

0.0.159 - 11.02.2026 | 13:12 - Документация синхронизирована с фактически закрытым storage checkpoint 6A: зафиксированы успешные CI/deploy backend 0.0.158, hardened SeaweedFS 4.51, два private bucket, пустые media-таблицы, public health и реальный disable/re-enable preservation drill. Уточнены права Docker secrets и оставшиеся 6B gates; runtime, OpenAPI 0.0.62, schema v32 и выключенный пользовательский media API не изменялись.

0.0.160 - 11.02.2026 | 13:54 - Подготовлен fail-closed checkpoint 6B: schema v33 добавляет pre-domain media intake, immutable target binding для inventory/receipt/diary/support/avatar, image-only JPEG/PNG/WebP policy, per-user/global quotas, durable CDR jobs, encrypted derived variants, review/reconciliation evidence и отдельную least-privilege media-worker role. Legacy inline OCR в production выключен; изолированный concurrency-one CDR container использует bounded child, exact-key readback и manual-review для неизвестных PUT/commit. Public storage/processor остаются выключены до VPS capacity/OOM drill; PDF/video/HEIC/community и malware-clean/publication не включены.

0.0.161 - 11.02.2026 | 15:43 - Исправлен fail-closed provisioning media-processor runtime: heredoc с role/password SQL теперь передаётся в PostgreSQL-контейнер через обязательный `docker exec -i`. Добавлена regression-проверка интерактивного stdin; обнаруженный на VPS прежний вызов не создавал login-role и останавливался на readback до запуска processor или изменения публичных media-флагов. На VPS закрыт бесплатный 6B capacity/isolation gate: hardened topology, cgroup OOM isolation, три 12 MP прогона JPEG/PNG/WebP, стабильный RSS и crash/restart подтверждены без production fixtures; processor снова удалён, пользовательский media API остаётся выключен до scanner/policy.
