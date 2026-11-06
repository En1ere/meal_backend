# ADR-052: Admin-read capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminReadController` and `AdminReadService`. The service injects only the global `DatabaseService`; the controller uses the global `AdminSessionGuard`. There are no HTTP DI consumers outside the controller and there is no `WorkerModule` provider. Integration tests resolve the service through the normal non-strict application graph.

`AdminReadBoundaryCapabilityModule` is a separate transaction authorization/audit boundary for admin observability. `AdminReadService` neither injects nor implements that boundary, so combining the two would create misleading ownership rather than a real dependency.

## Decision

`AdminReadCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability;
- owns `AdminReadController` and `AdminReadService` exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and admin-session guard;
- remains distinct from admin observability and its read boundary;
- is not imported by `WorkerModule`.

`admin/public.ts` explicitly names the contracts, source metadata, pure cursor/projection functions, controller and service already consumed by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/exports, controller/service ownership, guard and root-negative ownership.
- Runtime regression verifies controller/service identity and the unchanged database singleton.
- Worker isolation regression verifies no capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Administrative read queries have explicit acyclic ownership without merging unrelated observability infrastructure.
- Contracts and pure query helpers remain compile-time APIs.
- HTTP, OpenAPI, database, authorization and audit behavior remain unchanged.
