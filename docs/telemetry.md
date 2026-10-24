# Безопасная эксплуатационная телеметрия

Backend принимает только низкокардинальные сигналы с фиксированными кодами и сохраняет их в существующие append-only таблицы `admin_error_events` и `admin_metric_events`. Они доступны через действующие защищённые разделы админки `errors` и `metrics`.

## Покрытие

- Неожиданные HTTP 5xx backend фиксируются кодом `backend.http.unhandled`, с `request_id`, серверным окружением и необязательной версией приложения.
- Ошибка запуска после создания Nest application context фиксируется кодом `backend.startup.failed`.
- Next frontend сообщает `root_error`, `route_error`, `unhandled_error` и `unhandled_rejection`.
- Admin SPA сообщает `root_error`, `route_error`, `unhandled_error` и `unhandled_rejection`.
- External provider observer сохраняет только фиксированные service/outcome count и duration; имя адаптера, операция и исходная ошибка не записываются.
- One-shot workers дублируют безопасные outcome/duration/counters в `admin_metric_events`, а lease/failure alerts — в `admin_error_events`; JSON stderr остаётся независимым резервным каналом.
- Каждый error event сопровождается первичной count-метрикой с таким же фиксированным префиксом.
- Браузерные сигналы дедуплицируются по коду на одну минуту в пределах вкладки и отправляются только в real API mode.

Browser endpoint не принимает message, stack, path, query, body, user/email, cookie, token, произвольный context или timestamp. Время и environment назначает backend. `appVersion` может быть только SemVer либо `null`. Сообщение для администратора выбирается сервером из фиксированного словаря. `stack_summary`, `job_id` и `pseudonymous_id` всегда записываются как `null`.

Оба ingestion endpoint защищены существующей Origin/CSRF-проверкой, отдельным лимитом тела 1 KiB и route rate limit 20 запросов в минуту на IP. Пользовательский frontend использует `/api/v1/telemetry/browser`, admin origin — `/api/v1/admin/telemetry/browser`. Admin endpoint также наследует сетевое ограничение admin namespace.

## Best effort и границы

Запись телеметрии никогда не меняет основной бизнес-ответ: repository error перехватывается внутри `TelemetryService`. Browser reporter также не пробрасывает ошибки сети и не использует основной query/cache state.

Телеметрия хранится в той же PostgreSQL, что и приложение. Поэтому она принципиально не может надёжно зафиксировать отказ самой БД, потерю соединения pool или startup failure до создания application context. Для этих событий остаётся санитизированный stderr процесса; production platform должна собирать stdout/stderr во внешний log sink и контролировать `/health/ready` независимо от PostgreSQL. Это не заменяется записью в `admin_error_events`.

Embedded AI/cooking loops используют тот же shared lease, JSON fallback и административный sink. Включать их можно только после применения migration 024; в production дополнительно обязателен стабильный `WORKER_OWNER_ID`.

## Аудит console/logger/catch

- Production backend HTTP использует Fastify structured logger. Request serializer сохраняет только HTTP method без URL/path/query; error serializer не выводит исходный message/stack.
- `main.ts` и PostgreSQL pool пишут в stderr только фиксированные сообщения без объекта ошибки.
- `CookingLifecycleService` и `AiReconciliationService` используют фиксированные warning-сообщения без payload.
- Provider observer уже ограничивает наблюдение enum-полями, duration и attempt; исходная provider error не попадает в telemetry.
- Frontend feature-level `catch` показывает контролируемые UX-ошибки и не вызывает `console`. Новые root/route/global handlers отправляют только фиксированный код.
- Команды из `scripts/` используют console как CLI-вывод. Некоторые browser QA scripts печатают диагностический текст страницы при падении; они не входят в production runtime и должны запускаться только на тестовых данных.
- Operational worker stdout исключает domain result и содержит только status с тем же schema-validated observation; идентификаторы сущностей и provider payload туда не попадают.
- Mock scenario console существует только при development + mock mode и не включается в production build.

Новые категории событий добавляются только расширением серверных enum и словарей с тестом запрета произвольных полей. Нельзя добавлять raw exception, request URL, stack, form state или пользовательские идентификаторы.
