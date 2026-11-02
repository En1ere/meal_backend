# Encrypted media storage foundation

## Current safety state

Schema v32 and API contract `0.0.62` prepare an S3-compatible, provider-neutral lifecycle. The committed runtime deliberately uses `DisabledMediaObjectStore`: reservations return HTTP 503 and no object/metadata is created until a reviewed S3 adapter is installed. Malware scanning, promotion from `quarantine` to `ready`, and public delivery are not implemented in this checkpoint. This is fail-closed, not a partially working publication path.

The temporary VPS provider may be SeaweedFS. A later move must require only changing endpoint, credentials, buckets and region in the environment; domain services do not import provider SDK types.

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

## Future apply preflight

The following is a plan for the separately approved deployment; this checkpoint does not apply it.

```bash
npm ci
npm run check
npm run db:plan
docker compose config --quiet
docker compose pull seaweedfs backend
docker compose run --rm backend npm run db:plan
```

Before enabling traffic, verify all of the following:

1. migration manifest is exactly v32 / 216 tables / 494 foreign keys / PostgreSQL 18;
2. provider images are immutable-digest pinned and S3 port is not published on the host;
3. quarantine credentials cannot read/write the ready bucket except through the backend/scanner roles defined by the later checkpoint;
4. both buckets exist, public ACL/policy is absent, versioning/retention choice is recorded, and disk-pressure alerting is active;
5. backend readiness stays false/503 if endpoint, credentials, bucket, key version or adapter is unavailable;
6. test upload remains quarantined; EICAR/stale-signature/outage tests remain blocked until the scanner is installed;
7. rollback keeps schema/objects intact and disables new reservations by setting `MEDIA_STORAGE_ENABLED=false`.

## Acceptance matrix

- configuration: missing field, inline+`_FILE` collision, credentialed endpoint, endpoint path/port, same buckets, same crypto keys;
- reservation: unauthenticated/banned user, forbidden internal purpose, MIME/size boundary, idempotent replay and conflicting replay;
- upload: expired/tampered/wrong-action/wrong-owner token, asset mismatch, extra/missing file, declared MIME mismatch, magic mismatch, empty/truncated/over/under-sized stream, disconnect and provider timeout;
- isolation: cross-user status/download and object-key disclosure;
- encryption: round-trip, wrong nonce/tag/key version, truncated envelope, plaintext absence in object store;
- lifecycle: no direct quarantine-to-ready, no download before ready, immutable binding, infected/failed terminal behavior;
- resilience: provider down, DB failure after object PUT, duplicate PUT, restart during upload, orphan reconciliation and full disk;
- later scanner checkpoint: EICAR, clean file, stale/unavailable signatures, archive bomb policy, quarantine-to-ready copy verification and source deletion.
