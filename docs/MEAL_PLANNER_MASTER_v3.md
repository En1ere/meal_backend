# Meal Planner — master-навигатор

Этот файл не дублирует подробные требования. Действующая продуктовая спецификация разделена по темам в `docs/product/`, а фактическая реализация определяется кодом, схемой, OpenAPI и тестами.

## Общие правила

- Неизвестные данные не подменяются нулями, безопасностью или успешным эффектом.
- Права, тариф, family/private scope, consent и актуальность версии проверяются непосредственно перед действием.
- Повторяемые команды используют idempotency key; неопределённый результат требует readback/reconciliation.
- Provider-bound функции работают fail closed и явно объясняют пользователю, что недоступно и какой следующий шаг возможен.
- Отзыв обязательного согласия блокирует зависимую функцию. Интерфейс предлагает открыть документ и согласиться, но не принимает согласие автоматически.
- Sensitive/private данные не становятся публичными из-за роли владельца семьи, подписки или административного интерфейса.
- Loading, empty, partial, stale, validation, conflict, offline, timeout, provider failure и recovery являются обязательными состояниями.

## Темы

- [Обзор и аккаунт](docs/product/overview.md)
- [Семья и области данных](docs/product/family.md)
- [Тарифы и подписки](docs/product/subscriptions.md)
- [Запасы и продукты](docs/product/inventory.md)
- [Рецепты и готовка](docs/product/recipes.md)
- [Планирование и главная](docs/product/planning-home.md)
- [Покупки, чеки и финансы](docs/product/shopping-finance.md)
- [Питание и дневник](docs/product/nutrition.md)
- [AI](docs/product/ai.md)
- [Сообщество и модерация](docs/product/community.md)
- [Коммуникации и поддержка](docs/product/communications.md)
- [Offline](docs/product/offline.md)
- [Администрирование](docs/product/administration.md)
- [Медиа](docs/product/media.md)
- [Инфраструктура и качество](docs/product/quality-infrastructure.md)
- [Глоссарий](docs/product/glossary.md)
- [Открытые production-вопросы](docs/product/open-questions.md)

Экранные нормы находятся в `docs/product/screens-*.md`. Полная ручная проверка всего реализованного функционала, ролей, тарифов, API и corner cases — в [TESTs.md](TESTs.md).

## Юридический статус

Документы в [docs/legal](docs/legal/README.md) являются draft и показываются с соответствующей пометкой. Публикация и production-запуск заблокированы, пока не заполнены реальные реквизиты, инфраструктурные данные и не выполнено юридическое утверждение.

## Production readiness

Внешние release gates и provider-neutral манифесты описаны в [docs/production-readiness-scaffolds.md](docs/production-readiness-scaffolds.md). Моки, подготовленная миграция и локальный прогон не заменяют приёмку production-интеграции.
