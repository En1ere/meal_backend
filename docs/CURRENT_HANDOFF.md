# Точка передачи проекта meal

Актуально на 7 ноября 2026 года. Этот файл — стартовая точка для нового диалога после удаления предыдущей переписки. Он не содержит секретов и не разрешает продолжать архитектурную реализацию без последовательного согласования решений ниже.

## 1. Где остановились

Глобальный production-hardening и архитектурный этап приостановлены по решению владельца. Последняя завершённая работа — бесплатный AI foundation и отдельный план внешней активации. Следующая сессия начинается не с написания кода, а с подробного согласования AI-продукта, провайдера, моделей, тарифов, данных, экономики и safety.

Целевая формулировка следующего этапа: подготовить AI-контур до состояния, в котором после всех согласований, реализации и проверок для controlled activation останется только безопасно добавить provider API key и выполнить ограниченный activation smoke/eval.

Канонический план: [AI_ACTIVATION_ROADMAP.md](AI_ACTIVATION_ROADMAP.md).

Общий production tracker: [PRODUCTION_FREE_WORK_PLAN.md](PRODUCTION_FREE_WORK_PLAN.md).

## 2. Репозитории и зафиксированный baseline

Корень `test-roject` используется только как источник исходной информации; изменения выполняются независимо в трёх репозиториях.

| Репозиторий     | Ветка  | Зафиксированная версия/ревизия на момент handoff                              | Назначение                                                           |
| --------------- | ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `meal_backend`  | `main` | release `0.0.276`; точный SHA — `git rev-parse HEAD`                          | API, PostgreSQL migrations, workers, deployment и общая документация |
| `meal_admin`    | `main` | `0.0.166`, `890dd9c3c92f68ab1d6d3a70f462e93eb7f1a235`                         | операторская админка                                                 |
| `meal_frontend` | `main` | workspace `0.0.50`, app `0.0.267`, `1d0270e1e428cbc2a7119a8b7beaee50685919e3` | пользовательское приложение и design system                          |

Перед любой новой работой в каждом затронутом репозитории выполнить `git status --short`, `git rev-parse HEAD`, `git rev-parse origin/main` и прочитать его локальные инструкции. Не переносить незакоммиченные изменения между репозиториями и не изменять корень `test-roject`.

## 3. Что уже подготовлено для AI

- Версионированный каталог из 18 task codes и серверная проверка effective entitlement Free/Plus/Pro.
- Task-specific context manifests, consent checks и строгий structured result.
- Canonical async lifecycle: `202`, polling, durable queue, lease/fencing и отдельный least-privilege worker.
- Раздельные lifecycle/financial states, conservative reservation и monthly stop-loss.
- Read-only AI control plane в админке без раскрытия provider payload/secret.
- Offline `ai-model-eval-v1`, provider simulator/failure tests и 30-дневная очистка AI content с legal-hold исключением.
- Docker secret-file boundary, disable switch, observability и runbooks.

Текущая связка OpenAI Responses + `gpt-6-luna`/low — только проверенный технический baseline. Это не утверждённый коммерческий выбор провайдера или модели.

## 4. Следующая последовательность решений

Каждый блок обсуждается отдельно. Нельзя молча переходить к следующему или кодировать предположение как принятое решение.

1. **Продуктовые сценарии и тарифы.** Для каждого task code определить пользовательскую ценность, Free/Plus/Pro entitlement, необходимые доменные capabilities, источники контекста, стоимость в AI-действиях, уточнения, лимиты и разрешённое действие после результата.
2. **Провайдер.** Сравнить юридическую доступность, регион/retention/training policy, DPA, structured/background API, request identity/readback, rate limits, SLA, pricing и unknown-outcome semantics. Зафиксировать основной provider и допустимость fallback.
3. **Модели и routing.** Утвердить versioned model/profile для классов задач, reasoning, token/deadline limits, multimodal inputs, escalation/fallback и deprecation policy. Автоматическая эскалация на более дорогую модель запрещена.
4. **Качество и eval.** Утвердить correctness/schema/safety thresholds, негативные кейсы, latency/cost ceilings, human-review rubric и promotion gate.
5. **Данные и согласия.** Для каждого источника определить purpose/minimization, scope, consent/revocation, регион/subprocessors, provider storage/training и product retention/legal hold.
6. **Экономика.** Зафиксировать pricing snapshot, conservative ceilings, AI allowances/packages, положительный monthly budget, alert thresholds, stop-loss и contribution-margin target.
7. **Safety.** Утвердить аллергенные/медицинские границы, обязательные предупреждения, входную/выходную moderation policy, жалобы и запрет прямых доменных mutations из ответа модели.
8. **Unknown/reconciliation.** Отдельно решить операторский workflow. Рекомендуемый baseline: readback по существующему provider request id; без повторного submit и без ручного `succeeded`; release только при MFA и внешнем evidence.
9. **Админка.** Утвердить settings registry, безопасные статусы, budget/usage/queue/worker/eval views и allowlisted mutation flows через permission → MFA → preview → confirm → execute → audit/readback. Значение secret не вводится через браузер.

Полные вопросы, артефакты и Definition of Ready находятся в AI roadmap. При противоречии этот handoff является кратким указателем, а roadmap — подробным источником.

## 5. Реализация после согласования AI

Только после owner approval блоков 1–9:

1. адаптировать provider-neutral port и выбранный adapter;
2. зафиксировать routing/pricing/data/safety profiles;
3. реализовать согласованный reconciliation contract и admin flow;
4. подготовить exact env/secret-file names, Docker overlay, least-privilege role и egress allowlist;
5. обеспечить disabled/unconfigured startup, rotation/revoke и emergency disable;
6. пройти unit/contract/integration/provider-simulator failures, offline eval, architecture/security/secret scans и сборки;
7. обновить OpenAPI/generated clients, тест-кейсы и deployment/rollback/incident runbooks;
8. развернуть fail-closed release без key и доказать невозможность provider call.

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

Текущий статус глобальной задачи: **paused по просьбе владельца**. Возобновление начинается фразой уровня: «Продолжаем по `docs/CURRENT_HANDOFF.md`, сначала согласуем AI-сценарии и тарифы».
