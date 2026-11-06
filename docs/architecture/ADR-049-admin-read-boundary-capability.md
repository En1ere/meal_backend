# ADR-049: Admin-read-boundary capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration prerequisite
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Direct extraction of Admin Observability is blocked by `AdminReadBoundary`, which was owned directly by HTTP `AppModule`. `AdminObservabilityService` is its only HTTP DI consumer. The boundary injects only global `DatabaseService` and provides the transaction-local authorization and audit wrapper for the observability read.

The other observability providers remain independently root-owned: `AdminObservabilityRepository` injects global database, `HostSnapshotReader` is constructed by a configuration-dependent factory, and the service imports operational/provider schemas only as compile-time APIs. There is no worker/process consumer of the boundary.

## Decision

`AdminReadBoundaryCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability;
- owns `AdminReadBoundary` exactly once;
- exports the boundary to its real HTTP DI consumer;
- relies on global core for database;
- is not imported by `WorkerModule`;
- does not move the Admin Observability controller, service, repository or host-reader factory in this checkpoint.

The existing explicit `admin-auth/public.ts` remains the TypeScript boundary. No new provider token or alias is introduced.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider/export metadata and root-negative ownership.
- Runtime regression verifies the boundary uses the global database and current root-owned `AdminObservabilityService` receives the capability-owned singleton.
- Worker isolation regression verifies no capability or boundary provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Admin Observability is unblocked for a later single-capability extraction.
- Transaction authorization/audit behavior and singleton identity are preserved.
- Host snapshot factory, observability repository/service/controller and worker composition remain unchanged.
