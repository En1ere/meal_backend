# ADR-078: Media storage HTTP capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-077](ADR-077-media-object-store-prerequisite.md)

## Context

After extracting media object-store selection, the last root-owned controller is `MediaStorageController` and its only application provider is `MediaStorageService`. The controller injects only the service and uses the global `UserSessionGuard`. The service injects global `DatabaseService`, global `APP_CONFIG` and `MEDIA_OBJECT_STORE`.

No production provider outside the controller injects `MediaStorageService`, and `WorkerModule` has no media-storage HTTP or object-store consumer. The generic object-storage, key-management and malware-scanner aliases are not injected by this service and remain separate root infrastructure.

## Decision

`MediaStorageCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports exactly `MediaObjectStoreCapabilityModule`;
- owns `MediaStorageController` and `MediaStorageService`;
- relies on global core for database, application configuration and the user-session guard;
- exports nothing and is absent from `WorkerModule`.

`AppModule` imports the HTTP capability instead of importing the object-store prerequisite directly. The unused generic media-infrastructure aliases remain root-owned.

## Evidence

- Static composition regression verifies exact imports, controller, provider and empty exports.
- Guard metadata regression preserves the user-session boundary.
- Runtime regression verifies the controller/service, database/config and object-store singleton identities.
- Negative root and worker ownership regressions prevent duplicate instances.
- Exact generated OpenAPI protects every media route and schema.

## Consequences

- `AppModule` owns no controllers; media HTTP composition is acyclic and explicit.
- Media storage behavior, authorization, database transactions, provider selection and fail-closed semantics remain unchanged.
- Generic media infrastructure remains available for a later, independently evidenced checkpoint.
