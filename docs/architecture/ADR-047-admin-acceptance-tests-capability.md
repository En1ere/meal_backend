# ADR-047: Admin-acceptance-tests capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminAcceptanceTestsController`, `AdminAcceptanceTestsService` and `AdminAcceptanceTestsRepository`. The repository injects global `DatabaseService`; the service injects the repository and global `APP_CONFIG`; the controller injects the service and uses global `AdminSessionGuard`.

There are no provider tokens or aliases, external HTTP DI consumers, scheduled/process consumers or `WorkerModule` providers. The catalog loader and acceptance schemas are compile-time APIs used by tests and response validation.

## Decision

`AdminAcceptanceTestsCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability;
- owns the controller, repository and service exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database, configuration and admin-session guard;
- is not imported by `WorkerModule` and does not introduce provider tokens or factories.

`admin-acceptance-tests/public.ts` explicitly names the catalog, contracts, controller, repository and service required by existing source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/exports, controller/providers, guard and root-negative ownership.
- Runtime regression verifies controller-service-repository identity and the unchanged global database/config instances.
- Worker isolation regression verifies no capability, repository or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Acceptance-test administration has explicit core-only ownership without joining observability, notifications or content administration.
- Catalog and schemas remain compile-time APIs rather than Nest dependencies.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
