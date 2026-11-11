# Точка передачи проекта meal

Актуально на 11 ноября 2026 года. Этот файл — стартовая точка для нового диалога после удаления предыдущей переписки. Он не содержит секретов и не разрешает provider call либо архитектурную реализацию несогласованных блоков.

## 1. Где остановились

9 ноября 2026 года владелец согласовал все девять блоков: продуктовые сценарии, тарифы, backend-first routing, минимальные контракты, кэш, предварительный Yandex provider/model choice, launch-экономику, provider-neutral adapter/reconciliation, safety/eval и admin control plane. Реализованы девять совместимых срезов: runtime-neutral `ai-task-policy-v4`/v2 contracts, schema v39 frozen identity, backend-only executor со schema v40, public backend-only v2 boundary, provider-neutral port с выключенным Yandex adapter, durable provider-dispatch persistence/reconciliation schema v41, internal simulator-only `culinary_question/answer`, его fail-closed public activation boundary и internal simulator-only `substitution/candidates|explain`. Публично разрешён только cost-0 `shopping_list_generation/from_meal_plan`; Yandex adapter не подключён к task routes/worker и не может активироваться одним key. OpenAI/Luna остаётся выключенным legacy baseline.

Целевая формулировка следующего этапа: подготовить AI-контур до состояния, в котором после всех согласований, реализации и проверок для controlled activation останется только безопасно добавить provider API key и выполнить ограниченный activation smoke/eval.

Канонический план: [AI_ACTIVATION_ROADMAP.md](AI_ACTIVATION_ROADMAP.md).

Общий production tracker: [PRODUCTION_FREE_WORK_PLAN.md](PRODUCTION_FREE_WORK_PLAN.md).

## 2. Репозитории и зафиксированный baseline

Корень `test-roject` используется только как источник исходной информации; изменения выполняются независимо в трёх репозиториях.

| Репозиторий     | Ветка  | Зафиксированная версия/ревизия на момент handoff                     | Назначение                                                           |
| --------------- | ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `meal_backend`  | `main` | workspace `0.0.289`; точный SHA — `git rev-parse HEAD`               | API, PostgreSQL migrations, workers, deployment и общая документация |
| `meal_admin`    | `main` | workspace `0.0.167`; точный SHA — `git rev-parse HEAD`               | операторская админка                                                 |
| `meal_frontend` | `main` | workspace `0.0.51`, app `0.0.268`; точный SHA — `git rev-parse HEAD` | пользовательское приложение и design system                          |

Перед любой новой работой в каждом затронутом репозитории выполнить `git status --short`, `git rev-parse HEAD`, `git rev-parse origin/main` и прочитать его локальные инструкции. Не переносить незакоммиченные изменения между репозиториями и не изменять корень `test-roject`.

## 3. Что уже подготовлено для AI

- Версионированный каталог из 18 task codes и серверная проверка effective entitlement Free/Plus/Pro.
- Task-specific context manifests, consent checks и строгий structured result.
- Canonical async lifecycle: `202`, polling, durable queue, lease/fencing и отдельный least-privilege worker.
- Раздельные lifecycle/financial states, conservative reservation и monthly stop-loss.
- Read-only AI control plane в админке без раскрытия provider payload/secret.
- Offline `ai-model-eval-v1`, provider simulator/failure tests и 30-дневная очистка AI content с legal-hold исключением.
- Docker secret-file boundary, disable switch, observability и runbooks.
- Runtime-neutral policy v4 registry, minimal v2 contracts, schema v39 frozen preview identity и internal preview builder без provider call.
- Internal backend-only executor `shopping_list_generation/from_meal_plan`: точная plan version/selection, immutable source snapshot hash, deterministic persisted result, cost 0 и structured readback без provider/quota path.
- Public AI-v2 boundary открывает только готовый backend resolver: strict preview/run/readback, owner scope, CSRF/session guards и минимальная проекция без provider/financial internals. Legacy routes и model execution не переключались.
- Provider-neutral port фиксирует accepted/rejected/`unknown_without_identity`, readback states, запрет повторного submit и независимые user-quota/provider-budget effects. Выключенный Yandex adapter имеет exact endpoint/model URI, secret-file config, bounded timeout, structured output и simulator tests, но не подключён к public routes.
- Schema v41 хранит один sanitized provider dispatch на v2 model operation: immutable client/provider identity, normalized submit/read outcomes, RUB estimate/actual usage, CAS/version и lease fencing. Expiry reconciliation не вызывает provider: submit-crash становится `unknown_without_identity`, read-crash остаётся GET-reconcilable.

Текущая связка OpenAI Responses + `gpt-6-luna`/low — только проверенный технический baseline. Это не утверждённый коммерческий выбор провайдера или модели.

## 4. Статус последовательности решений

Каждый блок обсуждается отдельно. Нельзя молча кодировать предположение как принятое решение.

1. **Продуктовые сценарии и тарифы — согласовано.** `ai-task-policy-v4`: Free AI-рекомендации отсутствуют, backend/SQL обслуживает вычисления и подборки; Plus 20 действий, Pro 60, trial 5, пакет 20.
2. **Провайдер — target и adapter согласованы.** Yandex AI Studio выбран основным без runtime fallback; submit/readback/unknown contract зафиксирован. Legal/region/logging, `store:false` readback spike и activation evidence ещё обязательны.
3. **Модели и routing — согласовано как target.** Economy: Alice AI LLM Flash; balanced: YandexGPT Pro 5.1. Автоматические retry/escalation/fallback запрещены на всех слоях; task-specific token limits и provider ceilings зафиксированы в канонической AI-спецификации.
4. **Качество и eval — согласовано как target.** Strict schema, hard constraints и critical safety требуют 100%; economy correctness ≥95%, balanced ≥90%, p95 latency 45/120 секунд; утверждены минимальный объём fixtures, повтор critical cases и promotion gate.
5. **Данные и согласия.** Для каждого источника определить purpose/minimization, scope, consent/revocation, регион/subprocessors, provider storage/training и product retention/legal hold.
6. **Экономика — launch-гипотеза согласована.** Цены, квоты, package limits и per-task ceilings зафиксированы; перед реализацией ещё нужны точный pricing snapshot, положительный monthly budget и controlled-launch dashboards/alerts.
7. **Safety — согласовано как target.** Backend verdict нельзя переопределить моделью; неизвестный аллергенный состав и медицинские запросы fail closed с отдельными recovery codes; critical incident отключает task/profile без fallback.
8. **Unknown/reconciliation — согласовано как target.** До provider ID — `unknown_without_identity` с release user quota и отдельным provider budget hold; после ID — только GET/readback и `reconciliation_hold`. Повтор submit и ручной `succeeded` запрещены; operator release требует MFA и evidence.
9. **Админка — согласовано как target.** Readiness/budget/queue/eval/safety views и закрытый action registry проходят permission/MFA/preview/CAS/confirm/audit/readback; secret и deferred enable недоступны. Отдельная history-вкладка с `ai.history.read` показывает локальные user/assistant messages конкретного пользователя, требует reason/case reference и аудирует каждый просмотр.

Полные вопросы, артефакты и Definition of Ready находятся в AI roadmap. При противоречии этот handoff является кратким указателем, а roadmap — подробным источником.

## 5. Реализация после согласования AI

Только после owner approval блоков 1–9:

1. ~~адаптировать provider-neutral port и выбранный adapter~~ — выполнено изолированно и fail closed;
2. ~~реализовать durable provider operation persistence/reconciliation для v2~~ — выполнено schema v41;
3. ~~реализовать первый internal economy task через simulator и реальные quota/dispatch invariants~~ — выполнено для `culinary_question/answer`;
4. зафиксировать public activation boundary, routing/pricing/data/safety evidence и admin flow;
5. подготовить exact env/secret-file names, Docker overlay, least-privilege role и egress allowlist;
6. обеспечить disabled/unconfigured startup, rotation/revoke и emergency disable;
7. пройти unit/contract/integration/provider-simulator failures, offline eval, architecture/security/secret scans и сборки;
8. обновить OpenAPI/generated clients, тест-кейсы и deployment/rollback/incident runbooks;
9. развернуть fail-closed release без key и доказать невозможность provider call.

Definition of Ready: все решения и versioned artifacts утверждены; adapter/routing/tariffs/budget/reconciliation/admin реализованы; тесты и eval проходят; production worker выключен; secret inventory содержит только имя/владельца/rotation procedure; единственный отсутствующий конфигурационный материал — значение API key.

## 6. Остальные незакрытые production gates

После AI остаются внешние или owner-dependent блоки:

1. транзакционная почта: provider, sender domain, SPF/DKIM/DMARC, key и real inbox/bounce evidence;
2. media publication: malware scanner либо явно утверждённая non-public policy, capacity/retention/cleanup/legal-hold;
3. off-host encrypted backup и alerts: target/key custody/RPO/RTO/isolated restore/получатели;
4. реальные юридические реквизиты, contacts, subprocessors/regions и окончательное юридическое утверждение;
5. окончательный custom-domain/DNS/certificate/origin cutover;
6. оплаты и ККТ после выбора юрлица/providers и получения merchant/webhook secrets;
7. финальная приёмка: реальные provider cycles, physical iOS/Android, screen reader, external TLS/header probe, capacity/load и owner manual pack.

До закрытия соответствующего gate функция остаётся fail-closed и не имитирует внешний успех.

## 7. Развёрнутый стенд

- Пользовательское приложение: `https://abstract-usable-gazebo.ruweb.place/`
- Админка: `https://admin.abstract-usable-gazebo.ruweb.place/`
- Целевые домены после окончательного cutover: `meal.royalexander.online` и `admin.meal.royalexander.online`; технический домен сохраняется rollback alias до отдельного решения.
- Сервер: Ubuntu 24.04, Docker Compose deployment под `/srv/meal`.

Секреты, пароли, recovery keys и значения env в Git не сохраняются. Если новый диалог не имеет SSH/credential context, запросить доступ у владельца. Безопасные сведения о recovery: [LOCAL_BACKUP.md](LOCAL_BACKUP.md); deployment/readback/rollback: [DEPLOYMENT.md](DEPLOYMENT.md).

На момент создания handoff штатный VPS verify для всех компонентов проходил, backend/frontend/admin и инфраструктурные контейнеры были healthy, а свежие логи не содержали critical matches. Перед продолжением не полагаться только на эту запись: повторить read-only health/readback.

## 8. Проверки и команды продолжения

Backend release gate:

```text
npm ci
npm run check
npm run build
npm run audit:dependencies
```

После push в `main` дождаться обоих workflow для точного SHA: `Backend checks` и `Build and deploy backend`. Затем на VPS проверить latest backend deployment state (`revision`, `status`, `candidate.version`) и выполнить:

```text
sh /srv/meal/deployment/verify.sh --component all
```

Не считать push завершённым deployment, пока exact SHA/version не подтверждены серверным state/readback.

Manual test sources:

- Backend: [BACKEND_TESTING.md](BACKEND_TESTING.md), [DATABASE_TESTING.md](DATABASE_TESTING.md), [TESTs.md](TESTs.md).
- Admin: `meal_admin/ADMIN_TESTING.md`, `meal_admin/TESTs.md` и встроенный `/admin/testing`.
- Frontend: `meal_frontend/FRONTEND_TESTING.md` и `meal_frontend/TESTs.md`.
- Пересекающиеся frontend → admin → publication/provider сценарии выполняются отдельным финальным проходом после основных модульных проверок.

## 9. Правила возобновления

- Начать с блока «Продуктовые сценарии и тарифы», а не с выбора случайной модели по цене.
- Все тарифные AI-возможности наследуют доступность основной доменной функции: AI-баланс не открывает capability старшего тарифа.
- Существенные изменения контрактов, migrations, provider semantics, финансовых состояний или admin mutations отдельно согласовать.
- После каждого разрешённого изменения повысить patch-версию затронутого репозитория, обновить `version-list.md`, пройти релевантные проверки, commit/push и exact-revision deploy verification.
- Не раскрывать provider payload, prompt/context/result, request identity, ключи или PII в telemetry, логах и admin UI.
- Если внешний provider/key/budget/evidence отсутствует, состояние остаётся disabled/unconfigured, а не условно успешным.

Текущий статус AI-подготовки: **решения A–I согласованы; policy/contracts, schema-v39/v40 backend foundation, public backend-only v2 boundary, provider-neutral/Yandex adapter, schema-v41 persistence, internal simulator-only `culinary_question/answer`, его activation gate и `substitution/candidates|explain` реализованы без включения model runtime**. Наличие одного API key само по себе не включает provider call: нужны точные endpoint/folder/service-account/profile/budget, `store:false` evidence, явный enable и task-specific eval.

## 10. Точный checkpoint и очередь продолжения

Текущий завершённый шаг: internal `substitution/candidates|explain` замкнут на backend-first simulator pipeline. Кандидаты вычисляются SQL по активному каталогу и общей категории, сохраняются как короткоживущие owner-scoped артефакты; перед economy dispatch повторно проверяются owner, expiry, версии, category и статусы обоих ингредиентов. Модель получает только два названия и необязательный короткий вопрос, не выбирает и не применяет замену. Medical/allergen/prompt-injection boundary блокируется до модели; неизвестность аллергенного статуса добавляется backend. Quota/dispatch/readback/history используют schema-v41 invariants. Public route и Yandex binding не добавлены; OpenAPI и schema БД не изменены.

Внешний gate текущего шага: отдельный Yandex sandbox spike должен доказать background GET/readback при `store:false`. Официальная документация указывает, что `store:false` не сохраняет response; поэтому до реального evidence `YANDEX_AI_STORE_FALSE_READBACK_VERIFIED` нельзя выставлять в deployment. `store:true` требует нового owner decision.

Следующий внутренний шаг: **`storage_advice/rule|explain` через backend-first simulator-only pipeline**.

1. `rule` должен вычислить хранение и срок только из versioned catalog/composition/domain facts без модели и с cost 0.
2. `explain` принимает только backend verdict ID; модель получает минимальный уже проверенный verdict без профиля, истории и произвольного контекста.
3. Food-safety, medical и unknown-composition boundary остаются backend-authoritative; модель не меняет срок/температуру и не выдаёт безопасность как факт.
4. Переиспользовать schema-v41 dispatch, quota settlement, simulator failures и закрытую public activation boundary.

Не смешивать следующий срез с production enable, реальным ключом, `store:true`, массовым переводом legacy endpoints или deferred backlog. Checkpoint versions: backend `0.0.289`, frontend root/app `0.0.51/0.0.268`, admin `0.0.167`; точный backend SHA проверить после push через `git rev-parse HEAD`.
