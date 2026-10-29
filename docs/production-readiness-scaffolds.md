# Production readiness после разделения репозиториев

Provider-neutral manifests, browser-support matrix и deployment-strategy находятся в независимом `meal_frontend`. Там же находится их validator. В `meal_backend` нет `config/production-readiness`, `scripts/check-production-readiness.mjs` и `scripts/production-acceptance.mjs`; запуск этих путей из backend является ошибкой.

Backend владеет только собственными проверяемыми gates:

- migration manifest, schema baseline v29, application grants и backup/restore contract;
- worker topology и offline `npm run ops:readiness`;
- legal evidence через `npm run legal:readiness`;
- OpenAPI, backend tests и production runtime acceptance;
- health `/health/live` и `/health/ready`.

Frontend release evidence должно передавать точные версии root/front/admin и результат своего production-readiness validator, не создавая файловую зависимость backend от соседнего checkout. Backend сверяет эти значения только как внешнее release evidence. Текущий тестовый deployment и порядок rollout описаны в `docs/DEPLOYMENT.md`.

Deployment остаётся fail-closed: проверить immutable artifact и schema-v29 compatibility, оставить несогласованных workers/providers выключенными, подтвердить backup/restore evidence, применить миграции до переключения приложения, выполнить readiness и только затем открыть трафик. Переход на будущую schema требует обновления manifest и этого документа в том же release.

Production browser acceptance запускается только владельцем frontend-инструмента с публичными HTTPS origins, точными release versions и `allowMutations: false`. Backend не имитирует отсутствующий browser validator и не направляет mutation-oriented suites на production. Результат анонимного read-only прогона дополняет, но не заменяет authenticated smoke по `docs/DEPLOYMENT.md`.
