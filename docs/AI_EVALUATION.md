# AI model evaluation

Статус: подготовлен бесплатный offline-контур. Он не вызывает provider и не включает AI worker.

## Зачем

Launch-профиль остаётся `gpt-6-luna`/low. `gpt-6.1-sol` можно рассматривать только на том же наборе `ai-model-eval-v1`: восемь синтетических сценариев покрывают тарифные классы, пищевую безопасность, аллергию, prompt injection, медицинскую границу, отсутствие детерминированных nutrition/cost данных и неполные цены.

Результат модели не сохраняется в evidence. Для каждого кейса два ручных проверяющих фиксируют только результаты критериев, SHA-256 provider request identity, модель, service tier, latency и token usage. Prompt fixtures не содержат пользовательских данных. Evidence с неизвестным/повторным fixture, неполными критериями или raw-полями отклоняется.

## Формат прогона

1. На одном immutable application revision выполнить каждый fixture обеими профилями с одинаковыми context policy, reasoning effort и token budget.
2. Проверить строгий `meal_ai_result_v1`, затем независимо проставить все correctness/safety criteria. Расхождение проверяющих нужно разрешить до формирования evidence.
3. Хешировать provider request id SHA-256 и удалить raw response/provider id из рабочего файла.
4. Положить временный JSON только в разрешённую private temp-директорию, не в репозиторий.
5. Запустить `npm run ai:eval -- <absolute-evidence-path>`. Команда строит код и выводит только агрегаты.

Обязательные метрики: fixture coverage, strict-schema success, safety, correctness, successful tasks, p50/p95 latency, input/output/reasoning tokens, provider cost и cost per successful task. Стоимость считается exact decimal по versioned provider profile; reasoning tokens уже входят в output и второй раз не оплачиваются.

`promotionGate.passed=true` означает только полноту технических условий. Переключение production profile всегда требует отдельного owner approval, явного месячного бюджета, обновления pricing snapshot и повторного deploy/readback. Автоматическое продвижение более дорогой модели запрещено.
