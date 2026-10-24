# Экраны: модерация

> Статус реализации 6 октября 2026: служебный вход/MFA, `/moderation`, `/moderation/queues/:queue`, `/moderation/items/:id` и `/moderation/support/:id` реализованы в пользовательском frontend, development-моках и отдельном scoped backend API. Права повторно проверяются по staff-сессии, MFA, роли и grants; финансовые обращения не выдаются модератору. PostgreSQL/grants не применялись, browser QA не запускалась. Эффект «Пропустить уведомление» подтверждён пользователем и описан в журнале итерации. Исторические формулировки ниже о ещё отсутствующем API читаются как исходные требования, а не актуальный статус.

Часть спецификации **3.32.1**. [Master и приоритет правил](../../MEAL_PLANNER_MASTER_v3.md). Номера исходных разделов сохранены; уточнения §28 имеют прежний приоритет. История макетов и состояние реализации перенесены в архив.

<a id="source-1766"></a>
<!-- migration:source-1766 -->

<a id="246-встроенная-moderator-panel"></a>

## 24.6. Встроенная moderator-panel

<!-- /migration:source-1766 -->

<a id="source-1768"></a>
<!-- migration:source-1768 -->

Простое обращение: тема, статус, категория и назначение; разрешённый контекст и связанный материал; два сообщения с ролями «Пользователь»/«Поддержка»; пустое обязательное поле ответа и неактивная отправка. Данные и даты — placeholders. Desktop располагает переписку слева, контекст справа; mobile — контекст, переписку и ответ последовательно. Ответ предназначен автору обращения, не является внутренней заметкой; доставка/прочтение не обещаются. Возврат — `/moderation/queues/support`; связанный материал открывается только по разрешённой серверной проекции. Навигация: девять desktop-пунктов без active, пять mobile с active «Ещё».
<!-- /migration:source-1768 -->

<a id="source-1770"></a>
<!-- migration:source-1770 -->

SupportTicket schema и reply/reopen commands существуют, но безопасного moderator detail/messages read API нет. replySupport проверяет support.reply и запрещает payment не-admin; это не полная category/grant/scope policy для простых обращений. Нужны разрешённые ticket/messages/context projections, связанные материалы, словари подписей и capability/state matrix. Команда ответа проверяет expected_version/idempotency, пишет аудит, переводит тикет в waiting_for_user и назначает текущему сотруднику; это не доказательство доставки. Текст — 1–10000 символов после trim. Вложений в данном примере нет: attachment_ids до 20 не реализуют upload/scan/preview/access workflow; вложения и reopen остаются частью целевого сценария, не отменяются макетом. Закрытие/переназначение/внутренние заметки/санкции в этой паре не предлагаются. Нужны loading/partial/empty/error/retry/not-found/forbidden, недоступный связанный материал, validation/submitting/success/conflict/unknown outcome, offline, expired/MFA/reauth/revoke/risk hold. При конфликте сохранять ввод в разрешённой сессии, перечитать тикет; неизвестный исход сверять до повтора, offline не считать успехом. При отзыве очищать защищённые данные без неоговорённого persistent storage. Keyboard/focus, error summary, labels, announcements и touch targets проверяются при реализации. Production/API/DTO не менялись.
<!-- /migration:source-1770 -->

<a id="source-1772"></a>
<!-- migration:source-1772 -->

Пример проверки рецепта: публичный вид и защищённый оригинал, разрешённый контекст/сигналы, похожий материал, форма решения. Desktop сравнивает представления рядом, форма справа; mobile складывает секции и форму последовательно. Это не историческое «было/стало»: snapshots редакций в текущем DTO отсутствуют. Состояние материала отделено от состояния очереди; содержимое и статус — placeholders. Название/текст иллюстрируют будущую безопасную проекцию, не произвольный record. Действие и категория причины не выбраны, обоснование пустое, кнопка неактивна. Возврат — `/moderation/queues/recipes` с восстановлением разрешённого контекста списка. Обычный shell сохранён: девять desktop-пунктов без active, пять mobile с active «Ещё».
<!-- /migration:source-1772 -->

<a id="source-1774"></a>

> Актуализация 6 октября 2026: рабочий moderator-контур реализован. Пользователь подтвердил семантику «Пропустить уведомление»: материал остаётся в очереди без изменения статуса/назначения, записывается released claim с outcome `notification_skipped` и аудит. Исторические замечания ниже о незакрытом эффекте сохраняются только как происхождение решения.

<!-- migration:source-1774 -->

Это не полная capability/state/scope matrix. approve оставляет pending, publish переводит в published; одобрение не подменять публикацией. Нужны безопасные public_view/protected_original/context projections, словари signal_codes/reason_code, разрешённые действия по состоянию и grant/scope, безопасные previews похожих объектов и аудит чтения чувствительного контекста. Similarity не доказывает плагиат, сигнал не доказывает нарушение. Список действий не копируется целиком из enum. Категория обязательна, reason — 3–1000 символов после trim по текущей схеме; технические version/idempotency не показываются пользователю. Не обещать отправку причины автору. При conflict сохранить ввод в пределах разрешённой сессии и предложить повторную проверку свежего материала; unknown outcome сначала сверять, offline не считать успехом. Нужны loading/partial/error/retry/not-found/forbidden, отсутствие public/original/контекста/похожих, validation/submitting/success/conflict, expired/MFA/reauth/revoke/risk hold; при отзыве очистить защищённый контекст. Доступность keyboard/focus, labels, error summary и announcements проверяется при реализации. Production/API/DTO не менялись.
<!-- /migration:source-1774 -->

<a id="source-1776"></a>
<!-- migration:source-1776 -->

Пример — очередь recipes: две карточки, неназначенная queued с «Взять в работу»/«Пропустить уведомление» и назначенная мне in_review с «Открыть». Название, приоритет и срок — placeholders, состояния иллюстративные. Desktop сохраняет девять обычных пунктов без ложного active, mobile — пять с active «Ещё». Возврат к сводке ведёт на `/moderation`; открытие рецепта — на разрешённую `/moderation/items/:id` по серверной проекции. Фильтры статус/назначение/приоритет и «Загрузить ещё» предусмотрены интерфейсом. На mobile фильтры открывают bottom sheet с «Отмена»/«Применить», на desktop — компактные selectors.
<!-- /migration:source-1776 -->

<a id="source-1778"></a>
<!-- migration:source-1778 -->

Текущий AdminService.listQueue проверяет сессию и исключает admin-only очереди по роли, но не реализует полную grant/scope-фильтрацию. Клиент получает queue → array; cursor envelope, серверные фильтры, безопасные названия/capabilities/detail mapping и claim/skip отсутствуют. Макет не означает готовность этих сценариев. Claim требует проверки прав, версии, гонки назначения и идемпотентности; при конфликте обновляется карточка без ложного успеха. Пропуск уведомления не является отклонением/удалением рецепта или завершением задачи; точный эффект команды остаётся открытым. Offline-мутации не ставятся в фиктивную очередь, неизвестный результат сначала сверяется с сервером. Нужны loading/empty/no-filter-results/error/retry/stale, неизвестный срок, expired/MFA/reauth/revoked/risk-held; при отзыве защищённый контекст очищается. Сроки — ориентир, не гарантия. Keyboard/focus, announcements и touch targets проверяются при реализации. API, DTO и production-код в этой итерации не менялись.
<!-- /migration:source-1778 -->

<a id="source-1780"></a>
<!-- migration:source-1780 -->

Сводка встроена в app shell: desktop сохраняет девять обычных пунктов без ложного active; mobile — пять пунктов с active «Ещё». «Обзор» — текущий контекст, «Очереди» и «Мои задачи» — якоря на этой странице, не новые URL. Шесть категорий (recipes, recipe_variants, products, reports, support, authorship) иллюстрируют разрешённый набор, фактически фильтруемый grants и scope. Открытие очереди ведёт на `/moderation/queues/:queue`; задачи — на разрешённые `/moderation/items/:id` или `/moderation/support/:id` по серверной проекции. Никаких быстрых санкций или массовых решений.
<!-- /migration:source-1780 -->

<a id="source-1782"></a>
<!-- migration:source-1782 -->

Названия/счётчики/статусы/сроки — явные placeholders. Aggregate нельзя считать по первой странице выдачи; ошибка или неизвестность не равна нулю. SLA — целевой ориентир, не гарантия. Отдельные состояния: loading/partial/error/retry, пустые назначения, нет разрешённых очередей, неизвестные сроки, offline/stale, expiry/revoke/MFA/reauth/risk hold. При отзыве очищается защищённый контекст, повторное открытие задачи проверяет права. Read-only обзор не выдаёт полномочий назначения, claim/skip или публикации. Требуются безопасные scoped aggregates, assigned-to-me list, сроки и связь queue item с разрешённым detail; существующие schema и seeded core не доказывают готовность dashboard. Keyboard/focus, announcements, mobile labels и контраст проверяются при реализации.
<!-- /migration:source-1782 -->

<a id="source-1784"></a>
<!-- migration:source-1784 -->

Пользователь согласовал показ кода из приложения-аутентификатора. Параметры алгоритма, формат/длина, enrollment/recovery и runtime-контракт ещё требуют определения. Макет показывает одно пустое поле с явным label и вставкой полного кода, «Подтвердить» и «Вернуться ко входу» → `/moderation/sign-in`. Длина/формат кода, таймер, resend, enrollment, recovery и доверие устройству не задаются.
<!-- /migration:source-1784 -->

<a id="source-1786"></a>
<!-- migration:source-1786 -->

Нужны checking challenge, ready, submitting, server-confirmed success, неверный код, rate limit, offline, expired/revoked challenge и unknown outcome. Без разрешённого challenge не показывать чужой контекст. Просроченная/отозванная проверка возвращает к служебному входу; reload не подтверждает MFA. Не сохранять код в storage/логах. После успеха сервер повторно проверяет grants и нормализованный moderator returnTo; admin deep links недопустимы. Поддержать paste/autofill, keyboard/focus и status announcements; numeric inputmode — только после определения формата. PNG не доказывают доступность или рабочий auth lifecycle.
<!-- /migration:source-1786 -->

<a id="source-1788"></a>
<!-- migration:source-1788 -->

Для служебных страниц по прямому решению пользователя от 2026-09-14 готовить только один desktop и один mobile макет; при замечаниях править эту пару. Хранить moderator-макеты в `UI/service/moderator/<page>/`, admin и staff auth — в `UI/service/admin/<page>/`. До одобрения имена `desktop_1.png` и `mobile_1.png`, после явного одобрения — с `_selected`. Один пример не считается автоматически утверждённым. Это исключение из правила трёх вариантов; для пользовательских страниц прежнее правило сохраняется.
<!-- /migration:source-1788 -->

<a id="source-1790"></a>
<!-- migration:source-1790 -->

Использован первый auth split: кухня и форма. Почта/пароль опираются на общий стартовый способ §28.2, отдельные служебные credentials не вводятся. «Продолжить» инициирует проверку первого фактора и только по серверному результату переводит к `/moderation/mfa`; обычная сессия не повышает права. «Показать» управляет видимостью пароля, «На главную» ведёт на `/`. Нет регистрации, выбора роли или обхода MFA.
<!-- /migration:source-1790 -->

<a id="source-1792"></a>
<!-- migration:source-1792 -->

Нужны initial/validation/submitting, нейтральный отказ без раскрытия существования/роли аккаунта, server rate-limit/risk check, offline, MFA-required, challenge expired/revoked, denied/revoked access. До успешного MFA и серверной проверки grants защищённые данные не показываются. После MFA допустим только нормализованный moderator returnTo с повторной проверкой прав, не admin deep link. Пароль не сохраняется в storage/логах; поддержать paste/autofill/password manager, keyboard/focus, доступные labels и show/hide, status announcements и touch targets. Для moderator MFA согласован код из приложения; параметры алгоритма, enrollment/recovery, challenge TTL и endpoints пока не определены. Seeded /staff/me не реализует login/MFA lifecycle.
<!-- /migration:source-1792 -->

<a id="source-1794"></a>
<!-- migration:source-1794 -->

Moderator-panel остаётся защищённым разделом пользовательского приложения. Обычная сессия не даёт к нему доступ; служебная сессия имеет MFA, срок и grants. Недоступный маршрут не показывается в навигации и отклоняется backend.
<!-- /migration:source-1794 -->

<a id="source-1796"></a>
<!-- migration:source-1796 -->

| Маршрут                     | Страница                  | Назначение и ключевой результат                                                                   |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `/moderation/sign-in`       | Служебный вход модератора | Создать отдельную moderator session без повышения обычной пользовательской сессии                 |
| `/moderation/mfa`           | MFA модератора            | Подтвердить второй фактор и вернуться только на допустимый moderator deep link                    |
| `/moderation`               | Сводка модератора         | Показать доступные очереди, SLA-индикаторы без ложных гарантий и назначенные задачи               |
| `/moderation/queues/:queue` | Очередь                   | Фильтровать рецепты, варианты, товары, простые жалобы/авторство; взять или пропустить уведомление |
| `/moderation/items/:id`     | Проверка редакции         | Сравнить public/protected/context, похожие объекты и принять разрешённое решение с причиной       |
| `/moderation/support/:id`   | Простое обращение         | Ответить в пределах grant без доступа к платежам, ролям и полной личной информации                |

<!-- /migration:source-1796 -->

<a id="source-1805"></a>
<!-- migration:source-1805 -->

Состояния `staff-session-expired`, `mfa-required`, `reauth-required`, `access-revoked` и `risk-held` показываются отдельным блокирующим служебным экраном с безопасным выходом в обычное приложение. Risk hold не скрывается как пустая очередь и не раскрывает точные антифрод-пороги.
<!-- /migration:source-1805 -->
