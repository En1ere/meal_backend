# ADR-027: Core-only health capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The process liveness and database readiness surface belongs to the `platform-operations` bounded context. `HealthController` injects only the global core database provider. It has no service, repository, store, provider token or exported schema.

No HTTP application provider consumes a health provider, and worker composition has no health controller or provider. External tests and operational scripts refer only to stable operation IDs and routes.

After checkpoint 25, this single 24-line controller is the smallest remaining root-composition frontier. Larger core-only candidates still own services and workflow contracts, while other frontiers require one or more already-extracted capability dependencies.

## Decision

`HealthCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability;
- owns `HealthController` exactly once;
- declares and exports no provider;
- relies on the global core database provider without importing `CoreRuntimeModule` again;
- introduces no `forwardRef` or reverse capability dependency.

`health/public.ts` is the explicit named TypeScript composition boundary and exports only the controller.

Worker composition remains independent and must not import the capability.

## Evidence

- Architecture gates reject external deep imports into `health`.
- Static composition regression verifies exact empty imports/providers/exports, controller ownership, no root duplicate and worker isolation.
- Runtime composition regression verifies the controller receives the global database singleton.
- Exact generated OpenAPI regression protects liveness and readiness wire compatibility.

## Consequences

- Health ownership is explicit without introducing a ceremonial service.
- Operational semantics and readiness checks remain unchanged.
- No HTTP, OpenAPI, database, authorization, worker or health behavior changes in this checkpoint.
