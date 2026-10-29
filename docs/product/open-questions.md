# Открытые вопросы и условия запуска

Часть спецификации **3.32.1**. [Master и приоритет правил](../../MEAL_PLANNER_MASTER_v3.md). Номера исходных разделов сохранены; уточнения §28 имеют прежний приоритет. История макетов и состояние реализации перенесены в архив.

## 26.0. Актуальный production TODO на 29 октября 2026 года

Согласованный бесплатный execution tracker и список данных, которые потребуются от владельца, ведутся в [`docs/PRODUCTION_FREE_WORK_PLAN.md`](../PRODUCTION_FREE_WORK_PLAN.md). Платежи, ККТ, merchant secrets и финальное утверждение реквизитов вынесены за его пределы.

Тестовый production-like стенд уже использует PostgreSQL 18/schema v29 и общий Docker Compose для БД, backend, frontend и admin. TLS/Nginx, digest-pinned GHCR images, `main`-autodeploy, backup перед backend rollout, restore drill, least-privilege runtime role, обязательный admin MFA и container health/readiness проверены. Legacy application/PostgreSQL systemd units отключены. Это закрывает инфраструктурный cutover тестового стенда, но не разрешает публичный коммерческий запуск.

Оставшиеся работы закрываются последовательно; следующий пункт не включается production-ключами, пока предыдущий не имеет contract tests, provider sandbox evidence, timeout/unknown/retry/reconciliation проверки, мониторинг и документированный rollback/disable switch:

1. **Юридические и data-processing решения.** Заполнить реквизиты оператора, production-домены, регионы хранения/обработки, перечень subprocessors, retention/legal hold и согласовать 152-ФЗ, детские и специальные категории данных. Удалить `draft_blocked` можно только после юридического утверждения.
2. **Off-host backup и наблюдаемость.** Выбрать зашифрованное внешнее хранилище backup, KMS/key custody, retention, RPO/RTO и isolated restore target; подключить error/metric/trace sink, uptime probes, alert routing, disk/DB/container/certificate/queue/provider-budget alerts. Локальный dump на том же VPS не закрывает этот gate.
3. **Транзакционная почта.** Выбрать provider и sender domain, настроить SPF/DKIM/DMARC, production API/SMTP secret, bounce/complaint webhook и suppression policy. Проверить verify/recovery/email-change/security notifications, дедупликацию, provider timeout и неизвестный исход; marketing остаётся отдельно и default-off.
4. **Object storage/CDN и malware scanner.** Выбрать S3/R2-compatible storage, регион, bucket policy, encryption/KMS, lifecycle, signed URL TTL, quarantine и CDN. Подключить scanner до публикации любого asset; проверить abort/orphan cleanup, oversized/MIME mismatch, malicious/timeout/unknown result и удаление по retention/legal hold.
5. **OCR чеков и изображений.** После storage/scanner выбрать OCR provider, лимиты файлов/стоимости, минимизацию передаваемых данных и retention. Проверить receipt/inventory import, low-confidence review, duplicate/replay, 429/5xx/timeout, budget stop-loss и запрет доменного эффекта до подтверждения пользователя.
6. **Платежи, онлайн-чеки и возвраты.** Утвердить юрлицо/валюту/налоги, acquiring provider и интеграцию ККТ/чеков. Настроить production merchant/webhook secrets и подписи; принять sandbox и затем ограниченный live flow: checkout, pending/decline/unknown, replay/out-of-order webhook, trial, renewal, upgrade/downgrade, family coverage, partial/full refund, receipt delivery, idempotency и ledger reconciliation. Saved payment methods остаются blocked до выбора authoritative provider model.
7. **Push.** Утвердить Web Push provider/VAPID key custody, TTL/urgency/topic policy, endpoint cleanup и consent separation. Проверить revoked/expired endpoint, duplicate, quiet hours/timezone, security bypass policy, retry/backoff и отсутствие ложного `delivered`.
8. **AI provider.** Выбрать модель/поставщика/регион, data-training/retention policy, quality baseline, per-task budget и месячный stop-loss. Настроить production secret только после отдельного consent/data-minimization review; проверить reserve→call→commit/release, timeout/unknown/reconciliation, quota races, moderation и аварийное отключение.
9. **Workers и shared lease.** Подключить принятый lease/scheduler backend и telemetry, затем по одному включить email changes, exports, scheduled news/sanctions/incidents, retention inspection, account retention, AI reconciliation и cooking lifecycle. Для каждого нужны fencing, bounded batch/concurrency, poison isolation, kill/restart и alert evidence; destructive retention требует policy, legal-hold check и admin approval.
10. **Финальная приёмка публичного запуска.** Утвердить browser/device/accessibility matrix, физические iOS/Android проверки, external header/TLS probe, capacity/OOM/load drill, performance budgets, contribution-margin/provider-cost alerts и полный сквозной ручной цикл по `TESTs.md` на production providers.

Production credentials, webhook signing keys и provider payloads хранятся только в согласованном secret store/GitHub Environment и root-owned server secrets; в Git и клиентские bundles они не попадают. Пока конкретный пункт не закрыт, соответствующая функция остаётся fail-closed и не имитирует успешную оплату, отправку, загрузку, OCR/AI-результат или доставку.

<a id="source-2134"></a>
<!-- migration:source-2134 -->

<a id="26-открытые-вопросы-и-todo"></a>

# 26. Открытые вопросы и TODO

<!-- /migration:source-2134 -->

<a id="source-2136"></a>
<!-- migration:source-2136 -->

<a id="261-требуют-решения-до-или-во-время-реализации"></a>

## 26.1. Требуют решения до или во время реализации

<!-- /migration:source-2136 -->

<a id="source-2138"></a>
<!-- migration:source-2138 -->

1. Точная модель региональных, брендовых и вариантных цен товаров.
2. Окончательное место и стиль плашки стоимости в дизайн-системе.
3. Конкретный S3/R2-провайдер, CDN, резервное копирование, сроки и регионы хранения.
4. Точные лимиты антифрода: N рецептов, M комментариев, K реакций.
5. Точные форматы и допустимые размеры медиа после тестов на устройствах и стоимости хранения.
6. Точная техническая схема конфликтов синхронизации и UX ручного разрешения.
7. Юридические документы и финальная модель соответствия 152-ФЗ.
8. Конкретная AI-модель, стоимость, поставщик, политика данных и качество ответов.
9. Схема API, схема БД, миграции, авторизация, резервные копии и мониторинг.
10. Полный каталог достижений, числовые условия, веса репутации и защита от накрутки.
11. Производные семантические токены и состояния выбранных тем, визуальная идентичность, логотип и типографика. Базовые пары `nature-light`/`nature-dark` и `coffee-light`/`coffee-dark` приняты в §2.4.
12. Локализация и другие валюты.
13. Интеграции с магазинами, банковским кешбэком и бизнес-режим для ИП.
14. Параллельные локальные таймеры.
15. Субтитры видео.
16. **Отложено до подготовки релиза:** точный состав и безопасный UX семейного экспорта во время тарифной блокировки, когда содержимое семейного UI недоступно для просмотра.
17. **Отложено до подготовки релиза:** целевые значения contribution margin по тарифам, максимально допустимая доля AI/OCR и других переменных затрат, месячный бюджет и stop-loss для автоматического ограничения или аварийного отключения внешних платных функций.

<!-- /migration:source-2138 -->

<a id="source-2156"></a>
<!-- migration:source-2156 -->

18. **MP-01–MP-09, согласование 25 сентября 2026:** актуальный статус и уточнения — `docs/product-review-checklist.md`. Принятые части применяются; незакрытые последствия не заменять догадками.

<!-- /migration:source-2156 -->

<a id="source-2158"></a>
<!-- migration:source-2158 -->

<a id="262-рекомендуемый-порядок-реализации"></a>

## 26.2. Рекомендуемый порядок реализации

<!-- /migration:source-2158 -->

<a id="source-2160"></a>
<!-- migration:source-2160 -->

1. Общая техническая основа: API/БД/auth/права/audit/CI/backups и тестовый платёжный контур.
2. Итерация Free: личные запасы, рецепты, покупки, приготовление/остатки, базовые заготовки, OCR фото для запаса, Free-AI и ограниченный offline.
3. Итерация Plus: семья, общий реестр/покупки, чат/заметки, расширенное планирование/автоматизация и QR.
4. Итерация Pro: дневник/КБЖУ, финансы, PDF/электронные чеки, расширенный AI и отчёты.
5. Перед каждой публикацией: модерация/админка, миграции, безопасность и сквозная приёмка; после закрытого запуска — реальные платежи и пересмотр порогов по данным.

<!-- /migration:source-2160 -->

<a id="source-2166"></a>
<!-- migration:source-2166 -->

<a id="263-обязательные-gate-публичного-запуска"></a>

## 26.3. Обязательные gate публичного запуска

<!-- /migration:source-2166 -->

<a id="source-2168"></a>
<!-- migration:source-2168 -->

До публичного запуска должны быть закрыты и проверены:
<!-- /migration:source-2168 -->

<a id="source-2170"></a>
<!-- migration:source-2170 -->

1. Платёжные сценарии, чеки оплаты, возвраты, upgrade/downgrade, trial, страховка, семейные расширения и идемпотентность списаний.
2. Заполнить и утвердить [юридический draft-пакет РФ](../legal/README.md): согласия, персональные данные, детские профили, retention, удаление и авторские права. До production-деплоя неизвестны домен, реквизиты, регионы и реальные providers — это критический launch blocker.
3. Поставщики AI/OCR/email/push/object storage, лимиты бюджета и аварийное отключение платных внешних функций.
4. Auth/MFA для привилегированных ролей, RBAC, rate limits, аудит, апелляции и восстановление доступа.
5. Внешний мониторинг, резервные копии вне основного сервера и подтверждённое тестовое восстановление с утверждёнными RPO/RTO.
6. Browser/PWA matrix, сквозные тесты критичных циклов и ручной smoke-test владельцем на поддерживаемых браузерах.
7. Измерение contribution margin и бюджетные алерты хотя бы в тестовом режиме; реальные цены и лимиты должны быть конфигурируемыми и версионируемыми.

<!-- /migration:source-2170 -->

<a id="source-2178"></a>
<!-- migration:source-2178 -->

Feature-flag функции общего MVP включаются после прохождения приёмки своего ядра, отсутствия открытых критичных дефектов и успешного наблюдения тестового контура. Точные численные SLO и длительность стабильного окна определить до соответствующего включения.
<!-- /migration:source-2178 -->

<a id="source-2180"></a>
<!-- migration:source-2180 -->

---

<!-- /migration:source-2180 -->
