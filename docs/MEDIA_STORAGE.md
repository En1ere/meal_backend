# Encrypted media storage foundation

## Current safety state

Schema v32 and API contract `0.0.62` define an S3-compatible, provider-neutral lifecycle. Backend `0.0.156` contains a reviewed AWS-SDK adapter, while the production control plane separates two independent gates:

- `MEDIA_STORAGE_INFRA_ENABLED=true` starts the private local SeaweedFS provider only;
- `MEDIA_STORAGE_ENABLED=true` additionally connects the backend and enables reservation/upload endpoints.

Checkpoint 6A deploys only the first gate. User reservations continue to return HTTP 503 and the backend is not attached to the media network. Malware scanning, target binding, promotion from `quarantine` to `ready` and public delivery are not implemented in this checkpoint. This is fail-closed, not a partially working publication path.

The temporary VPS provider stores application-encrypted ciphertext in SeaweedFS. A later S3-compatible move changes endpoint, credentials, buckets and region without exposing provider SDK types to domain services.

## HTTP contract

All operations require a valid `meal_user` session. Mutations also require the existing `X-CSRF-Token`/Origin checks.

| Operation                                        | Purpose                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/media/reservations`                | Validate purpose/MIME/declared size, create an idempotent owner-bound reservation and return a 15-minute upload target.                                             |
| `GET /api/v1/media/assets/{id}`                  | Owner-only lifecycle status. It never returns an object key or encryption metadata.                                                                                 |
| `PUT /api/v1/media/assets/{id}/content`          | One multipart field named `file`, plus `X-Media-Upload-Token`. MIME magic and exact byte count are checked while the stream is encrypted and written to quarantine. |
| `POST /api/v1/media/assets/{id}/download-target` | Owner-only 5-minute download target; rejected unless the asset is `ready`.                                                                                          |
| `GET /api/v1/media/assets/{id}/content`          | Owner session plus `X-Media-Download-Token`; streams decrypted bytes only from the ready bucket.                                                                    |

User reservations are limited to `diary_photo`, `support_attachment`, `receipt_source`, `community_media`, and `profile_avatar`. `allergen_icon`, `export_file`, and `billing_document` remain internal/staff-only and have no user upload path. Purpose-specific limits are in `src/modules/media-storage/media-storage.policy.ts`; the absolute ceiling is 50 MiB. SVG is intentionally not accepted.

Every upload/download token is bound to action, asset, user, access-key ID, random reservation nonce and expiry. Tokens are never stored in PostgreSQL. The reservation claim is an atomic `reserved -> uploading` compare-and-swap on asset, owner, version and expiry; a concurrent or replayed completion never starts a second object write. Account status/sanctions are checked again immediately before upload and download effects.

Objects are encrypted by the application with a versioned AES-256-GCM envelope before S3 transport. Stable authenticated data binds ciphertext to `assetId`, purpose and key version, and download verifies the stored plaintext SHA-256 checksum before successful completion. PostgreSQL stores only checksum, nonce/tag/key reference/version. Quarantine and ready buckets must be distinct.

## Database lifecycle and cleanup boundary

Migration `032_media_storage_lifecycle.sql` adds:

- `media_upload_reservations`: immutable request identity, idempotency key, opaque object key and bounded upload lifecycle;
- `media_asset_bindings`: append-only encryption envelope metadata bound to the existing `media_assets` row;
- deferred consistency checks between reservation, asset and binding;
- restricted status transitions that prohibit `quarantined -> ready` without `scanning -> clean`;
- an expiry index for a future reconciler and least-privilege grants without metadata DELETE or publication UPDATE.

Successful PUT ends in `quarantined` and creates a pending `malware_scan` processing run with `publicationAllowed=false`. A provider error explicitly classified as `not_committed` may become terminal only after database readback confirms that no binding exists. Provider timeout/disconnect and unknown object PUT or database COMMIT outcomes remain `uploading` with `reconciliation_required`; the request never guesses by deleting an object. If COMMIT reports an error but readback finds a quarantined asset, completion returns that durable result.

Until the dedicated scanner/reconciler checkpoint exists, there is no automatic expiry/orphan deletion and storage must remain disabled in production. A future reconciler must only delete objects after it proves the binding/object outcome, addresses a terminal reservation after an agreed retention window and records its result; it must never list-and-delete unknown bucket objects blindly.

## Required deployment environment

Do not commit values. Production rejects inline storage, signing and encryption secrets. Store the three secret values in root-owned Docker secret files (`0400`) and pass the `_FILE` variables to the backend container.

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

`MEDIA_STORAGE_ENDPOINT` is a credential-free origin without port/path; port is separate. Plain HTTP is accepted in production only for an internal Docker DNS hostname. Public origin must be exact HTTPS. Signing and encryption keys are independent 32-byte random values encoded as base64. Never rotate/delete an encryption-key version while objects reference it.

## Checkpoint 6A deployment

`deploy/compose.media-local.yml` defines a non-root, read-only SeaweedFS container on an internal network without host ports. Its only writable mount is `/var/lib/meal-planner/media/provider`. `deploy/compose.media-backend.yml` is a separate activation overlay and is deliberately not selected while the API gate is false.

The host bootstrap creates independent storage credential, signing key and encryption key files, rejects symlinks/unsafe paths and requires at least 5 GiB and 20% free disk. Provider provisioning creates the two private buckets. Media is explicitly excluded from the current PostgreSQL-only backup and must be treated as disposable test data until checkpoint 9.

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

1. migration manifest is exactly v32 / 216 tables / 494 foreign keys / PostgreSQL 18;
2. provider images are immutable-digest pinned and S3 port is not published on the host;
3. quarantine credentials cannot read/write the ready bucket except through the backend/scanner roles defined by the later checkpoint;
4. both buckets exist, public ACL/policy is absent, versioning/retention choice is recorded, and disk-pressure alerting is active;
5. with `MEDIA_STORAGE_ENABLED=false`, backend has no media-network attachment and reservation remains 503;
6. provider preflight verifies both buckets without exposing credentials;
7. no user upload is attempted in 6A; EICAR/stale-signature/outage tests remain blocked until scanner/manual review exists;
8. rollback keeps schema/objects/keys intact and disables infrastructure without deleting the provider directory.

## Gate for checkpoint 6B

The generic purpose-only reservation contract is not enough for user traffic. Before `MEDIA_STORAGE_ENABLED=true`, reservations must be durably bound to an allowed diary/support/receipt/avatar/community target, with per-user/global quotas, bounded reconciliation and approved retention. Until then the provider may be healthy, but the upload API remains disabled.

## Acceptance matrix

- configuration: missing field, inline+`_FILE` collision, credentialed endpoint, endpoint path/port, same buckets, same crypto keys;
- reservation: unauthenticated/banned user, forbidden internal purpose, MIME/size boundary, idempotent replay and conflicting replay;
- upload: expired/tampered/wrong-action/wrong-owner token, asset mismatch, extra/missing file, declared MIME mismatch, magic mismatch, empty/truncated/over/under-sized stream, disconnect and provider timeout;
- isolation: cross-user status/download and object-key disclosure;
- encryption: round-trip, wrong nonce/tag/key version, truncated envelope, plaintext absence in object store;
- lifecycle: no direct quarantine-to-ready, no download before ready, immutable binding, infected/failed terminal behavior;
- resilience: provider down, DB failure after object PUT, duplicate PUT, restart during upload, orphan reconciliation and full disk;
- later scanner checkpoint: EICAR, clean file, stale/unavailable signatures, archive bomb policy, quarantine-to-ready copy verification and source deletion.
