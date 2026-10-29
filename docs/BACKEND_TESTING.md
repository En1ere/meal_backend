# Ручная приёмка Backend/API Meal Planner

Это последовательная программа production-like приёмки backend. Полная машинная карта операций находится в `openapi/openapi.json`, а историческая матрица покрытия — в `docs/TESTs.md`. Каждый endpoint должен быть сопоставлен с OpenAPI operation, реализацией, моделью БД, позитивным сценарием, набором отказов и хотя бы одним readback.

## 1. Входные условия

- PostgreSQL прошёл `docs/DATABASE_TESTING.md`.
- Backend собран production-командой; `npm run check`, `npm run openapi`, live PostgreSQL acceptance и dependency audit зелёные.
- Runtime использует отдельную роль с минимальными правами.
- Настроены разрешённые HTTPS origins; неизвестный Origin запрещён.
- Для внешних providers известен режим: подключённый sandbox либо явный fail-closed.
- У каждого запуска уникальные логины, UUID, idempotency keys и маркировка тестовых данных.

Для каждого теста фиксируйте method/path, роль/план, HTTP-код, безопасное тело, `requestId`, idempotency key, изменения БД и audit/readback.

## 2. Общий HTTP-контракт

Для каждой операции из OpenAPI проверить:

1. Валидный запрос возвращает описанный status/envelope.
2. Отсутствующее обязательное поле, лишнее поле, неверный enum/UUID/дата/размер возвращают согласованный 4xx до mutation.
3. Неверный content type, malformed JSON и превышение body limit различаются.
4. Неизвестный маршрут/метод не маскируется generic handler.
5. Response проходит сгенерированную схему и не содержит незадокументированных private-полей.
6. Cursor связан с route, page size, tenant/session и не принимается в другом контексте.
7. Ошибка содержит безопасный code/message/requestId, но не stack, SQL, secret, provider payload или персональные данные.

## 3. Security middleware

- CSRF обязателен для state-changing cookie-auth запросов и проверяется до БД mutation.
- Same-origin/Origin/Sec-Fetch-Site защищают browser-контур.
- Cookie имеют HttpOnly/Secure/SameSite/Path/expiry согласно контексту.
- Admin, moderator и user sessions не взаимозаменяемы.
- Rate limits разделены по чувствительным действиям и переживают новый экземпляр API при production storage.
- Helmet/security headers присутствуют; CORS не отражает произвольный origin.
- В логах и telemetry нет паролей, TOTP secrets, recovery codes, cookies, CSRF, provider tokens и полных payload.

## 4. Регистрация, вход, MFA и сессии

### Регистрация/вход

1. Зарегистрируйте пользователя с нормализуемым логином/email.
2. Повтор с другой раскладкой регистра/пробелами не создаёт дубль.
3. Неверные логин и пароль дают нейтральный ответ без enumeration.
4. Проверьте absolute/session expiry, logout и revoke other sessions.

### MFA

- Enrollment выдаёт случайный secret, принимает только допустимое временное окно и создаёт десять одноразовых recovery codes.
- Один challenge завершается ровно один раз; истёкший/заменённый challenge запрещён.
- Пять неверных попыток сохраняются конкурентно и применяют политику блокировки.
- Recovery-код не может сам создать factor и повторно не принимается.

### Staff/admin

- Обычный пользователь не получает staff/admin контекст.
- Moderator имеет только выданные permission.
- Admin critical window требует MFA, привязан к сессии, ограничен 30 минутами и абсолютным expiry.
- Последнего администратора нельзя отозвать/заблокировать до mutation.

## 5. Профиль, настройки и lifecycle аккаунта

- Профиль читает/меняет только разрешённые поля с optimistic version.
- Смена логина/email обрабатывает уникальность и повторную верификацию.
- Notification/privacy/security settings сохраняются атомарно.
- Export request имеет реальный lifecycle и не выдаёт URL без storage/provider result.
- Account deletion проходит request → review/blockers → ready export → finalization; `export_not_ready` хранится и аудируется.
- Повтор finalization идемпотентен; параллельный stale review получает 412/409.

## 6. Семья и приглашения

1. Создайте семью, пригласите пользователя и примите invitation.
2. Проверьте два параллельных accept: один участник, один эффект.
3. Добавьте family member без аккаунта, измените его допустимые данные.
4. Проверьте роли owner/member, передачу владения и выход.
5. Запретите доступ пользователю другой семьи ко всем ID.

Ожидается: семья всегда имеет допустимого owner; Plus/Pro покрытие вычисляется актуально; смена владельца, ban или deletion не теряют данные и не повышают права.

## 7. Каталог, аллергены, единицы и импорт

- Списки/поиск/фильтры используют cursor pagination и стабильную сортировку.
- Product, variant, category, attribute, density и unit conversion проходят строгую схему.
- Конверсия несовместимых единиц отклоняется; округление соответствует продуктовым правилам.
- Allergen mapping хранит тип, статус, источник и optimistic version.
- Merge duplicate требует полного preview/critical confirmation, сохраняет variants, source IDs и историю.
- Повтор merge идемпотентен; изменившаяся composition блокирует устаревший preview.
- Media/import без scanner/storage остаётся fail-closed; не создаётся доверенный asset до проверки.

## 8. Запасы и партии

1. Создайте партии в разных местах хранения, включая expiry.
2. Выполните receipt, consumption, correction, transfer и archive.
3. Проверьте частичное списание, ноль, превышение остатка и параллельное списание.
4. Перечитайте ledger и итоговый balance после каждого шага.

Ожидается: отрицательный остаток невозможен, движения append-only/аудируемы, повтор команды не удваивает эффект, чужая семья не видит партию.

## 9. Рецепты, revisions, готовка и заготовки

### Рецепт

- Создание проверяет минимальные поля, ингредиенты, шаги, порции и автора.
- Draft/private видит только допустимый контекст.
- Submit создаёт pending revision, не заменяя публичную.
- Approve атомарно переключает public revision; reject сохраняет предыдущую.
- Edit после публикации создаёт новую revision; stale update получает conflict.

### Готовка

- Start/resume/finish/abandon имеют корректный state machine.
- Таймер шага не позволяет недопустимые переходы и сохраняет readback.
- Portion/count/time statistics не удваиваются при retry.
- Остатки/заготовки и QR ссылаются на существующие сущности и корректно истекают.

## 10. Планирование и покупки

- План на неделю изолирован семьёй; права owner/member соблюдаются.
- Параллельное редактирование дня/приёма пищи возвращает конфликт или объединяет только согласованные поля.
- Shopping list генерируется из актуального плана, учитывает запасы и не создаёт дублей при retry.
- Item toggle/quantity/note readback устойчив к reload.
- Receipt import/OCR без provider/scanner fail-closed; подтверждение создаёт движения/цены ровно один раз.
- Деньги хранятся и возвращаются в minor units без float-ошибки.

## 11. Дневник питания, ограничения и аналитика

- Diary entry привязан к пользователю/дате/meal и корректной portion assignment.
- Archive исключает запись из активной аналитики только после успешной команды.
- Nutrition analytics учитывает диапазон, timezone, empty-state и большие значения.
- Аллергии/ограничения/оборудование влияют на подбор, но не раскрываются другому пользователю.
- Параллельная запись/архивация не приводит к двойному учёту.

## 12. AI

Проверить Free, Plus, Pro и former-Pro.

- Effective plan определяет доступный bucket/модель/лимит.
- Reservation → provider call → commit/release квоты атомарны.
- Timeout/ошибка provider освобождает reservation либо переводит её в явное recoverable состояние.
- Повтор результата не списывает квоту дважды.
- Prompt/context ограничен, очищен от лишних private-данных и проходит policy.
- Safety refusal не маскируется как success.
- Внешний AI provider без конфигурации fail-closed.

## 13. Подписки, квоты и платежи

- Free/Plus/Pro entitlements совпадают с продуктовой матрицей.
- Gift нельзя наложить на активный оплаченный период вопреки правилам.
- Revoke gift сохраняет paid period; freeze сдвигает expiry только на duration.
- Family coverage обновляется после grant/revoke/ban/owner transfer.
- Payment order/attempt/webhook имеют подпись, replay protection и idempotency.
- Неизвестный или неверно подписанный webhook не меняет ledger/subscription.
- Refund без реального provider result не меняет деньги и статус.

## 14. Сообщество, подписки на авторов и достижения

- Public feed показывает только approved/public revision.
- Bookmark/follow/comment/reaction/helpful idempotent и изолированы пользователем.
- Жалоба создаётся один раз на target/revision и попадает в moderation queue.
- Достижение начисляется по server-side condition; secret скрывает условие до получения.
- Reputation scale и achievement catalog меняются только опубликованным content release.
- Антифрод/санкция не удаляют исторический факт без audit.

## 15. Модерация

1. Frontend отправляет новую revision.
2. Moderator/admin получает точную pending revision.
3. Approve, reject, hide и unpublish проверяются на отдельных фикстурах.
4. Причина обязательна, где это предусмотрено.
5. Конфликт двух решений имеет одного победителя.
6. Неизвестный исход повторяется тем же command key и даёт один audit/effect.

## 16. Чат, семейные заметки и поддержка

- Chat message, reply, reaction, mention, draft и pagination не смешивают семьи.
- Удаление разрешено только контрактом и не уничтожает audit/history неожиданно.
- Family note поддерживает версии, совместное редактирование, conflict и readback.
- Support ticket: create, assign, private note, public reply, close/reopen.
- Private note никогда не возвращается user endpoint.
- Attachment без storage/scanner fail-closed.

## 17. Уведомления и новости

- Каналы default-off; email требует верифицированного адреса.
- Quiet hours корректны через полночь и timezone; security bypass ограничен scheduling.
- Acknowledge идемпотентен и не меняет соседнее уведомление.
- News audience: OR внутри фильтра, AND между фильтрами; неизвестные даты и отсутствие consent исключают пользователя.
- Scheduled campaign можно отменить только до отправки.
- Push/email без провайдера не помечаются delivered.

## 18. Admin operations, incidents, legal и rollback

- Job inspect/preview/execute различает safe/unsafe/running/financial operations.
- Retry/cancel требуют допустимого статуса и command idempotency.
- Incident source immutable; workflow lifecycle хранит actor/reason/version.
- Ignore требует причину и будущий expiry.
- Legal preview показывает blockers, но не создаёт архив/удаление сам по себе.
- Rollback применяет только ready items и сохраняет поздние чужие изменения.
- Все критичные действия требуют permission + MFA critical window + audit.

## 19. Workers и расписание

Для news, incidents, retention, sanctions и diary-portions:

1. Запустите worker в одиночном режиме и при пустой очереди.
2. Добавьте due, future, stale, revoked и malformed задания.
3. Запустите два экземпляра конкурентно.
4. Проверьте lease/claim, retry/backoff, dead-letter/incident и метрики.
5. Перезапустите процесс посередине выполнения.

Ожидается: одно задание имеет одного исполнителя/эффект; lease не остаётся вечным; production использует shared lease backend. In-memory координация допустима только локально.

## 20. Надёжность и сбои

- БД недоступна: live может оставаться живым, ready падает, mutations не притворяются успешными.
- Медленный/оборванный клиент отменяет работу, когда это безопасно; поздний ответ не затирает новую сессию.
- Provider timeout/retry не создаёт двойной платёж, уведомление, списание квоты или публикацию.
- Shutdown перестаёт принимать новые запросы и завершает/освобождает активные работы.
- 10k+ тестовые наборы подтверждают pagination/index behavior без неограниченного ответа.

## 21. Производительность и утечки ресурсов

1. Isolated PostgreSQL acceptance должен выполнить latency pack, 40 параллельных запросов и forced-GC heap guard. Рост heap bounded request pack не превышает 96 МБ; p95 каждого локального operation budget остаётся внутри зафиксированного порога. Для диагностического замера через WAN/SSH допускается `ACCEPTANCE_REMOTE_LATENCY_MULTIPLIER` от 1 до 10. Если API и БД намеренно разделены WAN-туннелем, `ACCEPTANCE_REMOTE_FUNCTIONAL_ONLY=true` оставляет schema/SQL-plan/полный функциональный проход, но явно пропускает request-level latency/burst/heap pack. Ни один удалённый режим не заменяет локальный gate со значениями по умолчанию; режим и топология обязаны попасть в отчёт.
2. Проведите 30-минутный soak с постоянной смесью read/mutation, keep-alive и отменённых запросов. Каждую минуту фиксируйте process RSS/heap/external, event-loop lag, active handles, pool total/idle/waiting и PostgreSQL sessions. После прогрева метрики должны выйти на плато, а не расти линейно.
3. Повторите connect/disconnect, multipart abort, OCR/import timeout, provider timeout и graceful shutdown не менее 100 раз. Ожидается: streams/workers/timers/AbortSignal listeners освобождаются, временные buffers недостижимы после GC, соединения возвращаются в pool.
4. На high-cardinality fixtures снимите `EXPLAIN (ANALYZE, BUFFERS)` для shopping, family notes/chat, moderator queues, search и analytics. N+1, неограниченные выборки и сортировки с выходом в temp — FAIL.
5. Проверьте backpressure: при исчерпанном pool новые запросы ограниченно ждут/падают контролируемо, readiness отражает проблему, а восстановление БД возвращает сервис без перезапуска и без накопленной очереди обещаний.

## 22. Наблюдаемость

- Каждый запрос имеет bounded request/correlation ID.
- Метрики различают status/classification без high-cardinality user IDs.
- Логи достаточны для диагностики, но не содержат private payload.
- Alert sink и telemetry sink реально подключены в production; отсутствие является release gate.
- Audit и operational incident связываются с запросом без раскрытия секрета.

## 23. Сквозные сценарии

После отдельных проверок admin/frontend пройти:

1. Recipe submit → moderator approve → publish либо full-admin approve с немедленной публикацией; reject сохраняет старую публикацию, replace закрывает её, hide закрывает рецепт глобально, unpublish снимает только active publication. Любая full-admin moderation mutation (`approve/reject/hide/unpublish`) требует действующие `x-admin-unlock` и critical MFA-window до idempotency replay. Затем проверить frontend и admin-content readback по независимым `review`/`publication`: для active r1 + rejected r2 review указывает r2 и sanitized `publicReason`, publication — r1; internal notes не входят в эти оси, stale revision=409.
2. Support create → admin private/public actions → user readback.
3. Family invite/accept → shared plan/inventory/note → role/owner change.
4. Plus/Pro grant/freeze/revoke → quotas/AI/family coverage.
5. Content release → achievement/reputation publication → rollback.
6. News campaign → audience selection → exactly-once notification.
7. Account export/deletion lifecycle → blockers → finalization.

## 24. Критерии завершения

- Каждая OpenAPI operation привязана к test case и имеет positive/negative/auth/idempotency evidence.
- Модели ответа совпадают с текущим OpenAPI; frontend/admin snapshots синхронизированы.
- Все mutation подтверждены readback, БД и audit там, где он обязателен.
- Внешние интеграции либо проверены в sandbox, либо явно fail-closed.
- `npm run check`, isolated PostgreSQL acceptance, production build/start smoke и dependency audit зелёные.
- Latency/concurrency/heap guard, SQL optimization pack и длительный resource soak не показывают линейного роста памяти, handles, listeners, pool waiters или PostgreSQL sessions.
- Production blockers из `npm run ops:readiness`, `ops:topology` и `legal:readiness` закрыты или явно приняты владельцем до запуска.
- Тестовые данные удалены, база возвращена к baseline.
