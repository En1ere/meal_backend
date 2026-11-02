# Encrypted media storage foundation

## Current safety state

Schema v33 extends the S3-compatible lifecycle with pre-domain intakes, immutable domain targets, quotas and durable image-processing evidence. Production continues to separate infrastructure, HTTP API and processor activation:

- `MEDIA_STORAGE_INFRA_ENABLED=true` starts the private local SeaweedFS provider only;
- `MEDIA_STORAGE_ENABLED=true` additionally connects the backend and enables target-bound reservation/upload endpoints;
- `MEDIA_PROCESSOR_ENABLED=true` starts the isolated, concurrency-one image CDR worker through its own Compose profile and secrets.

Checkpoint 6A deployed only the provider gate. Schema/API/processor changes in 6B do not themselves enable traffic. User reservations continue to return HTTP 503 while `MEDIA_STORAGE_ENABLED=false`. CDR strips metadata and re-encodes a bounded image, but is not an antivirus verdict; raw originals are never published. Promotion to public/downloadable `ready`, malware scanning and public delivery remain closed.

The temporary VPS provider stores application-encrypted ciphertext in SeaweedFS. A later S3-compatible move changes endpoint, credentials, buckets and region without exposing provider SDK types to domain services.

## HTTP contract

All operations require a valid `meal_user` session. Mutations also require the existing `X-CSRF-Token`/Origin checks.

| Operation                                        | Purpose                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/media/reservations`                | Validate purpose/MIME/declared size, create an idempotent owner-bound reservation and return a 15-minute upload target.                                             |
| `POST /api/v1/media/intakes`                     | Create an idempotent owner/scope-bound `inventory_scan` or `receipt_photo` intake before a receipt or inventory object exists.                                      |
| `GET /api/v1/media/assets/{id}`                  | Owner-only lifecycle status. It never returns an object key or encryption metadata.                                                                                 |
| `PUT /api/v1/media/assets/{id}/content`          | One multipart field named `file`, plus `X-Media-Upload-Token`. MIME magic and exact byte count are checked while the stream is encrypted and written to quarantine. |
| `POST /api/v1/media/assets/{id}/download-target` | Owner-only 5-minute download target; rejected unless the asset is `ready`.                                                                                          |
| `GET /api/v1/media/assets/{id}/content`          | Owner session plus `X-Media-Download-Token`; streams decrypted bytes only from the ready bucket.                                                                    |

User reservations are image-only JPEG/PNG/WebP and require exactly one allowed target: `inventory_source`/`receipt_source` to an owned intake, `diary_photo` to an owned diary entry, `support_attachment` to the requester's existing non-internal message, or `profile_avatar` to the current user. Image inputs are limited to 10 MiB (avatar 5 MiB) and three positions, except diary/avatar which allow position zero only. `community_media`, PDF, video and HEIC remain fail-closed. Internal catalog/export/billing purposes have no user upload path.

Every upload/download token is bound to action, asset, user, access-key ID, random reservation nonce and expiry. Tokens are never stored in PostgreSQL. The reservation claim is an atomic `reserved -> uploading` compare-and-swap on asset, owner, version and expiry; a concurrent or replayed completion never starts a second object write. Account status/sanctions are checked again immediately before upload and download effects.

Objects are encrypted by the application with a versioned AES-256-GCM envelope before S3 transport. Stable authenticated data binds ciphertext to `assetId`, purpose and key version, and download verifies the stored plaintext SHA-256 checksum before successful completion. PostgreSQL stores only checksum, nonce/tag/key reference/version. Quarantine and ready buckets must be distinct.

## Database lifecycle and cleanup boundary

Migration `032_media_storage_lifecycle.sql` provides quarantine reservation/encryption. Additive migration `033_media_target_processing.sql` adds:

- `media_intakes` and append-only `media_intake_sources` for receipt/inventory images before domain creation;
- immutable reservation targets for intake, diary entry, support message and avatar user, with deferred exact-link invariants;
- durable `media_processing_jobs` with lease/fencing and source checksum binding;
- encrypted derived-variant bindings plus categorical CDR evidence;
- append-only OCR review snapshots and reconciliation attempts;
- least-privilege HTTP and isolated processor roles without metadata DELETE.

Successful PUT ends in `quarantined`, atomically creates the exact domain/intake link and enqueues `image_cdr` with `publicationAllowed=false`. Per-user limits are 10 active reservations, 100 MiB declared per rolling 24 hours and 500 MiB stored; global limits are 100 active reservations and 20 GiB stored. Replays do not consume quota twice. Provider timeout/disconnect and unknown object PUT or database COMMIT outcomes remain reconciliation-required; the request never guesses by deleting an object.

The isolated processor decrypts only an exact source, invokes sharp in a bounded child process, strips metadata, normalizes orientation/colour/size, re-encodes to canonical JPEG/PNG, encrypts a new object and requires exact-key readback evidence before a fenced DB commit. Unknown PUT/readback/commit is `manual_review`, never automatic retry. No automatic expiry/orphan deletion is enabled; reconciliation records evidence and never list-and-deletes bucket contents.

## Required deployment environment

Do not commit values. Production rejects inline storage, signing and encryption secrets. Store the three backend secret values as `root:meal-secrets 0640` Docker secret files and pass the `_FILE` variables to the backend container. The provider identity configuration is a separate `root:meal-media 0440` file readable only by the non-root SeaweedFS group.

```dotenv
MEDIA_STORAGE_ENABLED=true
MEDIA_STORAGE_ENDPOINT=http://seaweedfs
MEDIA_STORAGE_BACKEND_PORT=8333
MEDIA_STORAGE_REGION=us-east-1
MEDIA_STORAGE_ACCESS_KEY_ID=meal-backend
MEDIA_STORAGE_SECRET_ACCESS_KEY_FILE=/run/secrets/media_storage_secret_access_key
MEDIA_STORAGE_QUARANTINE_BUCKET=meal-media-quarantine
MEDIA_STORAGE_READY_BUCKET=meal-media-ready
MEDIA_STORAGE_PREFIX=meal
MEDIA_STORAGE_FORCE_PATH_STYLE=true
MEDIA_STORAGE_PUBLIC_ORIGIN=https://abstract-usable-gazebo.ruweb.place
MEDIA_STORAGE_SIGNING_KEY_FILE=/run/secrets/media_storage_signing_key
MEDIA_STORAGE_ENCRYPTION_KEY_FILE=/run/secrets/media_storage_encryption_key
MEDIA_STORAGE_KEY_VERSION=1
```

The processor has independent `MEDIA_PROCESSOR_*` settings and accepts secrets only through absolute `_FILE` paths. `deploy/provision-media-processor-runtime.sh` creates `meal_media_runtime` with explicit `SET ROLE meal_media_worker`; it is not a member of `meal_app` or `meal_mail_worker`. The opt-in overlay is `deploy/compose.media-processor.yml`. Its fixed concurrency is one, with a 384 MiB memory limit, 0.75 CPU, 64 PID limit, 64 MiB no-exec tmpfs, read-only root filesystem, no ingress and no egress network. Do not start the profile until the dedicated SeaweedFS identity and secret files have been provisioned and verified.

`MEDIA_STORAGE_ENDPOINT` is a credential-free origin without port/path; port is separate. Plain HTTP is accepted in production only for an internal Docker DNS hostname. Public origin must be exact HTTPS. Signing and encryption keys are independent 32-byte random values encoded as base64. Never rotate/delete an encryption-key version while objects reference it.

## Checkpoint 6A deployment

`deploy/compose.media-local.yml` defines a non-root, read-only SeaweedFS container on an internal network without host ports. Its only writable mount is `/var/lib/meal-planner/media/provider`. `deploy/compose.media-backend.yml` is a separate activation overlay and is deliberately not selected while the API gate is false.

The host bootstrap creates independent storage credential, signing key and encryption key files, rejects symlinks/unsafe paths and requires at least 5 GiB and 20% free disk. Provider provisioning creates the two private buckets. Media is explicitly excluded from the current PostgreSQL-only backup and must be treated as disposable test data until checkpoint 9.

Production evidence for backend `0.0.158`: GitHub checks run `41409742965` and build/deploy run `41409742853` completed successfully; the running backend image matches the root-owned digest manifest. SeaweedFS 4.51 is healthy on the internal `meal-media` network, publishes no host port, mounts only the provider directory writable, and retains both private buckets across the tested disable/re-enable cycle. Storage key checksums and provider files stayed unchanged during the cycle, all three media tables remained empty, and public liveness/readiness returned HTTP 200. The control-plane backup is retained under the dated root-only backup directory; the upload API remains disabled.

Preflight:

```bash
npm ci
npm run check
npm run db:plan
docker compose config --quiet
sh deploy/bootstrap-media-storage.sh
docker compose -f deploy/compose.production.yml -f deploy/compose.media-local.yml config --quiet
docker compose pull seaweedfs backend
docker compose run --rm backend npm run db:plan
```

Before enabling traffic, verify all of the following:

1. migration manifest is exactly v33 / 223 tables / 513 foreign keys / PostgreSQL 18;
2. provider images are immutable-digest pinned and S3 port is not published on the host;
3. quarantine credentials cannot read/write the ready bucket except through the backend/scanner roles defined by the later checkpoint;
4. both buckets exist, public ACL/policy is absent, versioning/retention choice is recorded, and disk-pressure alerting is active;
5. with `MEDIA_STORAGE_ENABLED=false`, backend has no media-network attachment and reservation remains 503;
6. provider preflight verifies both buckets without exposing credentials;
7. no user upload is attempted in 6A; EICAR/stale-signature/outage tests remain blocked until scanner/manual review exists;
8. rollback keeps schema/objects/keys intact and disables infrastructure without deleting the provider directory.

## Gate for checkpoint 6B

Before `MEDIA_STORAGE_ENABLED=true`, schema v33 and least-privilege roles must be applied, the dedicated processor identity/buckets must pass exact permissions, and the processor must pass JPEG/PNG/WebP worst-case memory, timeout, kill, restart, stale-lease, ambiguous PUT/commit and no-growth drills on the 1.9 GiB VPS. Public/downloadable readiness remains blocked until a real malware scanner or an explicitly approved non-public policy exists. OCR is a separate checkpoint and always produces `requiresReview=true`.

## Acceptance matrix

- configuration: missing field, inline+`_FILE` collision, credentialed endpoint, endpoint path/port, same buckets, same crypto keys;
- reservation: unauthenticated/banned user, forbidden internal purpose, MIME/size boundary, idempotent replay and conflicting replay;
- upload: expired/tampered/wrong-action/wrong-owner token, asset mismatch, extra/missing file, declared MIME mismatch, magic mismatch, empty/truncated/over/under-sized stream, disconnect and provider timeout;
- isolation: cross-user status/download and object-key disclosure;
- encryption: round-trip, wrong nonce/tag/key version, truncated envelope, plaintext absence in object store;
- lifecycle: no direct quarantine-to-ready, no download before ready, immutable binding, infected/failed terminal behavior;
- resilience: provider down, DB failure after object PUT, duplicate PUT, restart during upload, orphan reconciliation and full disk;
- later scanner checkpoint: EICAR, clean file, stale/unavailable signatures, archive bomb policy, quarantine-to-ready copy verification and source deletion.
