# ADR-053: Admin-runtime-settings capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminRuntimeSettingsController`, `AdminRuntimeSettingsService` and the `LocalBackupStatusReader` factory. The service injects global `DatabaseService`, global `AdminAccessService`, the reader and `APP_CONFIG`; the controller uses global `AdminSessionGuard`.

The reader consumes a bounded root-owned host status artifact. No backup process, maintenance runner or worker injects these HTTP providers. Contracts and reader validation functions are compile-time APIs used by shared OpenAPI code and tests.

## Decision

`AdminRuntimeSettingsCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability;
- owns the controller, service and reader factory exactly once;
- preserves the existing factory condition and fixed path exactly: `OBSERVABILITY_HOST_SNAPSHOT_ENABLED` selects `/run/meal-observability/local-backup.json`, otherwise the reader is disabled;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for config, database, admin access and admin-session guard;
- does not own or import backup, maintenance or worker infrastructure;
- is not imported by `WorkerModule`.

`admin-runtime-settings/public.ts` explicitly names the contracts, validation helpers, controller, service and reader already consumed by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/exports, controller/service/reader ownership, guard and root-negative ownership.
- Factory regression verifies the exact `APP_CONFIG` injection, enable condition and fixed path.
- Runtime regression verifies controller, service, reader, database, admin-access and config singleton identities.
- Worker isolation and exact generated OpenAPI regressions protect process separation and the unchanged HTTP surface.

## Consequences

- Admin runtime settings have explicit acyclic HTTP ownership without absorbing backup infrastructure.
- Host status validation remains a compile-time public API and runtime read remains fail closed.
- HTTP, OpenAPI, database, authorization, backup and worker behavior remain unchanged.
