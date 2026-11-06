# ADR-077: Media object-store prerequisite capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`MediaStorageService` is the sole HTTP-application DI consumer of `MEDIA_OBJECT_STORE`. The token selects between `DisabledMediaObjectStore` and `S3MediaObjectStore` from `APP_CONFIG`: storage enabled selects the S3 adapter, otherwise the disabled adapter. The S3 adapter independently validates its complete configuration and stays unconfigured and fail-closed when required values are absent.

The media controller and service remain a later application-capability boundary. The generic object-storage, key-management and malware-scanner aliases are currently unused by this service and are separate infrastructure concerns. `WorkerModule` has no media object-store consumer.

## Decision

`MediaObjectStoreCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no capability and relies only on global `APP_CONFIG`;
- owns `DisabledMediaObjectStore`, the `S3MediaObjectStore` config factory and the exact existing `MEDIA_OBJECT_STORE` selector;
- exports only `MEDIA_OBJECT_STORE` for `MediaStorageService`;
- owns no controller and is absent from `WorkerModule`.

`MediaStorageService`, `MediaStorageController` and the unrelated generic media-infrastructure aliases remain root-owned. The module's explicit `public.ts` API is the only supported external import boundary.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider factory injections, selector identity and the single exported token.
- Runtime regression verifies disabled selection, fail-closed preflight behavior and the exact token injected into the root-owned service singleton.
- Negative ownership regression prevents root provider duplicates.
- Worker isolation and exact generated OpenAPI protect process and route boundaries.

## Consequences

- Object-store adapter selection has one composition owner without changing configuration or runtime semantics.
- The HTTP media application layer remains independently extractable in a later checkpoint.
- Enabling storage still selects the S3 adapter, while incomplete S3 configuration remains unavailable rather than falling back or starting partially configured.
