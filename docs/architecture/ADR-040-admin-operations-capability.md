# ADR-040: Admin-operations capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `OperationsWorkspaceController`, `OperationsWorkspaceService` and `OperationalMaintenanceService`. Both services inject only global `DatabaseService`; the controller injects the workspace service and uses global `AdminSessionGuard`. There are no provider tokens or aliases.

Operational maintenance is also registered independently in `WorkerModule` and invoked by scheduler/process scripts. That registration is intentionally process-scoped: the HTTP capability must not be imported into the worker. Observability, rollback and scheduler implementations are not injected into these services and remain separate boundaries.

## Decision

`AdminOperationsCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability;
- owns the HTTP-app controller and both HTTP-app service instances exactly once;
- exports nothing because no other HTTP provider injects either service;
- relies on global core for database and admin-session guard providers;
- does not import or merge observability, rollback or scheduler capabilities;
- does not replace the separate `WorkerModule` maintenance provider.

`admin-operations/public.ts` is the explicit named TypeScript boundary for the controller, services, schemas, types and pure availability policy. External source, worker, script and test consumers use this boundary; architecture gates prohibit deep imports.

## Evidence

- Static composition regression verifies exact imports, controller, providers, exports, guard and root-negative ownership.
- Runtime composition regression verifies controller/workspace/maintenance identity against the HTTP database singleton.
- Worker isolation regression verifies no HTTP capability import, no workspace service and a retained process-scoped maintenance provider.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Admin operations ownership is explicit without creating an operational mega-module.
- HTTP and worker maintenance instances remain process-local as before.
- HTTP, OpenAPI, database, authorization, scheduler and worker behavior remain unchanged.
