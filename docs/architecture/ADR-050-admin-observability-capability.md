# ADR-050: Admin-observability capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-049](ADR-049-admin-read-boundary-capability.md)

## Context

After extracting `AdminReadBoundary`, HTTP `AppModule` still directly owned `AdminObservabilityController`, `AdminObservabilityService`, `AdminObservabilityRepository` and the configuration-dependent `HostSnapshotReader` factory. The service injects the boundary, repository and reader; the repository injects global `DatabaseService`; the controller uses global `AdminSessionGuard`.

Operational-runtime and provider-runtime references are schemas and fixed topology enums used at compile time. They are not injectable dependencies. There are no external HTTP DI consumers or `WorkerModule` providers.

## Decision

`AdminObservabilityCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports exactly `AdminReadBoundaryCapabilityModule`;
- owns the controller, service, repository and host-reader provider exactly once;
- preserves the host-reader factory as `inject: [APP_CONFIG]` and passes the configured snapshot path only when host snapshots are enabled, otherwise `undefined`;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database, configuration and admin-session guard;
- does not import telemetry, operational-runtime or provider-observation capabilities for compile-time schemas;
- is not imported by `WorkerModule`.

`admin-observability/public.ts` explicitly names the schemas, controller, service, repository, reader and pure snapshot policies required by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact import/controller/providers/exports, factory token/injection and guard metadata.
- Runtime regression verifies boundary/repository/reader/service/controller identity, global database identity and the unchanged enabled/path factory projection.
- Worker isolation regression verifies no observability capability or provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Observability ownership and its configuration-dependent filesystem adapter are explicit and acyclic.
- Compile-time worker/provider schemas do not create artificial Nest dependencies.
- HTTP, OpenAPI, database, authorization, filesystem validation and worker behavior remain unchanged.
