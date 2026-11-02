# OCR preview: deployment and operations

This checkpoint exposes RU+EN OCR only as an editable preview. It does not persist source bytes, OCR text or a domain record. Every successful response contains `requiresReview: true`; inventory rows and receipt text still require an explicit user review before a separate save request.

## Production boundary

- `ocr-preview` runs from the same immutable backend image on the internal `meal-ocr` network, without host ports, database, object storage or egress networks.
- The container is read-only, drops all capabilities, uses `no-new-privileges`, PID 64, CPU 0.75 and memory 512 MiB. Only one recognition job runs at a time.
- The backend sends one raw JPEG/PNG/WebP per request. The sidecar performs the normal 12 MP CDR pass before Tesseract and returns at most 20,000 characters.
- `rus.traineddata` and `eng.traineddata` are checked against `resources/ocr/models.manifest.json` before the listener starts.
- Authentication uses a dedicated 64-hex token file. The token, image bytes and recognized text must never be logged.
- Durable uploads, publication and automatic domain mutation stay disabled until the separate malware-scanner/storage gate is accepted.

## Enable

Run as root after the release image and the current deployment files are installed:

```sh
/srv/meal/deployment/bootstrap-ocr-preview.sh
sed -i 's/^OCR_PREVIEW_ENABLED=.*/OCR_PREVIEW_ENABLED=true/' /etc/meal-planner/deploy.env
/srv/meal/deployment/stack.sh up
/srv/meal/deployment/verify.sh --component all
```

If `OCR_PREVIEW_ENABLED` is absent, add exactly `OCR_PREVIEW_ENABLED=true` to the root-owned deploy environment. Do not place the token value in that file. The default secret path is `/etc/meal-planner/secrets/ocr-preview-token` with `root:meal-secrets 0640`.

Acceptance requires:

1. `docker inspect` shows only `meal-ocr` for the sidecar and no port bindings.
2. Sidecar health is healthy and backend live/ready remain HTTP 200.
3. An authenticated scan returns RU+EN text, `requiresReview: true` and no database/media mutation before confirmation.
4. Invalid MIME, oversized/decompression-bomb input, missing/wrong token, concurrent request and timeout fail closed.
5. A sidecar crash/restart and a separate cgroup OOM drill do not restart or degrade backend/PostgreSQL.

## Disable and rollback

Set `OCR_PREVIEW_ENABLED=false`, then run:

```sh
/srv/meal/deployment/disable-ocr-preview.sh
```

The helper removes the sidecar and recreates backend without `meal-ocr`; the token is intentionally preserved for a later re-enable. Verify that scan returns the stable unavailable response while manual inventory/receipt entry and table import remain available. Only after this disable step may the ordinary backend image rollback run; the rollback helper refuses an enabled OCR overlay so an older image cannot be started as an incompatible sidecar. Database rollback is not involved because this checkpoint adds no migration.

## Operator diagnostics

Use only categorical metadata:

```sh
docker compose --env-file /etc/meal-planner/deploy.env -f /srv/meal/deployment/compose.production.yml -f /srv/meal/deployment/compose.ocr-preview.yml --profile ocr-preview ps
docker inspect --format '{{.State.Health.Status}} {{.RestartCount}}' "$(docker compose --env-file /etc/meal-planner/deploy.env -f /srv/meal/deployment/compose.production.yml -f /srv/meal/deployment/compose.ocr-preview.yml --profile ocr-preview ps -q ocr-preview)"
```

Do not print the secret, request body, worker result or container environment. A timeout/busy/unavailable result is recoverable: the UI keeps manual entry available and must not save a partial OCR result.
