# Admin observability runbook

`GET /api/v1/admin/observability` возвращает bounded snapshot для активной admin-сессии с MFA. Перед чтением backend повторно проверяет live session, пользователя, роль admin и TOTP в той же транзакции, а успешное чтение записывает `admin.observability.read`. Ответ всегда `Cache-Control: no-store` и содержит только фиксированные группы `host`, `database`, `queue`, `workers`, `providers`: без container IDs, имён процессов, SQL, raw errors, paths, environment и provider payloads.

## Freshness и состояния

- `fresh` — sample моложе своего `staleAfterSeconds`;
- `stale` — sample существует, но просрочен; старое значение не выдаётся за текущее;
- `no_samples` — для фиксированного worker/provider ещё нет telemetry;
- `unavailable` — host snapshot выключен, отсутствует или отвергнут strict reader.

Host snapshot стареет через 150 секунд. Reader принимает только parent directory `root:meal-observability 2750` и обычный файл `root:meal-observability 0640` до 64 KiB, открытые с `O_NOFOLLOW`; схема, cardinality, mtime и future skew проверяются fail-closed. DB/queue читаются bounded aggregates из текущей schema, worker leases и существующей operational telemetry под transaction-local `statement_timeout=2s`. Endpoint ограничен 12 запросами в минуту на client IP. Идентификаторы пользователей, jobs и lease owners не возвращаются.

## Установка collector на Docker-host

Этот host bootstrap обязателен **до первого rollout compose-файла с observability mount**: `create_host_path:false` намеренно не создаёт directory. CI/deploy user не получает root authority и не устанавливает эти файлы автоматически. Как root из проверенного backend release сначала создать versioned backup существующих root artifacts и checksum manifest, затем установить candidate:

```sh
release_id=observability-0.0.145-$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=/var/backups/meal-planner/root-artifacts/$release_id
install -d -o root -g root -m 0700 "$backup_dir"
for path in /usr/local/libexec/meal-planner/host-observability-collector.py /etc/sysusers.d/meal-observability.conf /etc/tmpfiles.d/meal-observability.conf /etc/systemd/system/meal-observability-collector.service /etc/systemd/system/meal-observability-collector.timer; do
  if [ -f "$path" ]; then cp --preserve=mode,ownership,timestamps "$path" "$backup_dir/$(printf '%s' "$path" | tr / _)"; fi
done
(cd "$backup_dir" && find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum > SHA256SUMS)
candidate_stage="$backup_dir/candidate"
install -d -o root -g root -m 0700 "$candidate_stage"
install -o root -g root -m 0755 deploy/host-observability-collector.py "$candidate_stage/host-observability-collector.py"
install -o root -g root -m 0644 deploy/sysusers.d/meal-observability.conf "$candidate_stage/meal-observability.sysusers.conf"
install -o root -g root -m 0644 deploy/tmpfiles.d/meal-observability.conf "$candidate_stage/meal-observability.tmpfiles.conf"
install -o root -g root -m 0644 deploy/systemd/meal-observability-collector.service "$candidate_stage/meal-observability-collector.service"
install -o root -g root -m 0644 deploy/systemd/meal-observability-collector.timer "$candidate_stage/meal-observability-collector.timer"
(cd "$candidate_stage" && sha256sum ./* > ../CANDIDATE_SHA256SUMS)
(cd "$candidate_stage" && sha256sum -c ../CANDIDATE_SHA256SUMS)
install -d -o root -g root -m 0755 /usr/local/libexec/meal-planner
install -o root -g root -m 0755 "$candidate_stage/host-observability-collector.py" /usr/local/libexec/meal-planner/host-observability-collector.py
install -o root -g root -m 0644 "$candidate_stage/meal-observability.sysusers.conf" /etc/sysusers.d/meal-observability.conf
install -o root -g root -m 0644 "$candidate_stage/meal-observability.tmpfiles.conf" /etc/tmpfiles.d/meal-observability.conf
install -o root -g root -m 0644 "$candidate_stage/meal-observability-collector.service" /etc/systemd/system/meal-observability-collector.service
install -o root -g root -m 0644 "$candidate_stage/meal-observability-collector.timer" /etc/systemd/system/meal-observability-collector.timer
systemd-sysusers /etc/sysusers.d/meal-observability.conf
systemd-tmpfiles --create /etc/tmpfiles.d/meal-observability.conf
systemctl daemon-reload
systemctl enable --now meal-observability-collector.timer
systemctl start meal-observability-collector.service
[ ! -s "$backup_dir/SHA256SUMS" ] || (cd "$backup_dir" && sha256sum -c SHA256SUMS)
```

Проверить `systemctl status meal-observability-collector.timer`, `journalctl -u meal-observability-collector.service --since -15m` и metadata файла: directory `root:meal-observability 2750`, snapshot `root:meal-observability 0640`. Collector использует только stdlib Python 3 и fixed absolute Docker argv, ограничивает каждую команду 2 секундами/32 KiB, пишет через fsync + atomic rename. Unit не имеет network, capabilities, provider secrets или write-доступа вне snapshot directory.

Только после успешного bootstrap запускается обычный backend rollout. Его install gate проверяет exact host metadata до остановки writers. Production Compose всегда монтирует directory `/var/lib/meal-planner/observability` read-only в backend как `/run/meal-observability`, добавляя фиксированный supplemental GID 29002 без env override. Docker socket никогда не монтируется в application containers. Worker, frontend, admin и PostgreSQL snapshot не видят. Если Docker недоступен, collector всё равно атомарно публикует fresh `partial` snapshot с `missing/unknown` container states, пишет фиксированное warning-сообщение и успешно завершает oneshot; nonzero остаётся только для internal/write failure.

## Disable и rollback

Emergency disable без изменения БД:

1. установить `OBSERVABILITY_HOST_SNAPSHOT_ENABLED=false` и `OBSERVABILITY_HOST_SNAPSHOT_FILE=` в root-owned `deploy.env`;
2. выполнить обычный backend component rollout/recreate и `deploy/verify.sh --component backend`;
3. `systemctl disable --now meal-observability-collector.timer`;
4. убедиться, что endpoint показывает `host.freshness.state=unavailable` и `unavailableReason=disabled`, а DB/queue/worker/provider секции продолжают работать.

Даже в disabled mode безопасный read-only mount и directory metadata обязательны; файл может отсутствовать. Disable не удаляет mount/directory и поэтому не ломает будущий rollback.

Rollback выполняется в обратном порядке: сначала предыдущий backend digest штатным application-only rollback, затем root выполняет точное восстановление:

```sh
systemctl disable --now meal-observability-collector.timer
[ ! -s "$backup_dir/SHA256SUMS" ] || (cd "$backup_dir" && sha256sum -c SHA256SUMS)
for path in /usr/local/libexec/meal-planner/host-observability-collector.py /etc/sysusers.d/meal-observability.conf /etc/tmpfiles.d/meal-observability.conf /etc/systemd/system/meal-observability-collector.service /etc/systemd/system/meal-observability-collector.timer; do
  saved="$backup_dir/$(printf '%s' "$path" | tr / _)"
  if [ -f "$saved" ]; then cp --preserve=mode,ownership,timestamps "$saved" "$path"; fi
done
systemctl daemon-reload
```

Если artifact отсутствовал в backup, новый файл не удаляется автоматически: оператор сверяет release manifest и отдельно подтверждает removal. Новых migrations/grants нет; snapshot directory и mount сохраняются.

## Alerts и owner input

Внешняя отправка alerts в этом checkpoint **отключена**. Admin snapshot не отправляет email/webhook и не содержит channel secret. Для следующего этапа владелец должен выбрать канал (email/Telegram/webhook), получателя и пороги; secret передаётся только через server/GitHub secret store. До этого оператор вручную реагирует на `stale/unavailable`, unhealthy/missing containers, restarts, disk pressure, due/failed queue, worker failures и provider timeout/error.
