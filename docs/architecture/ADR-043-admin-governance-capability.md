# ADR-043: Admin-governance capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminGovernanceController` and `AdminGovernanceService`. The service injects only global `DatabaseService` and `AdminAccessService`; the controller injects the service and uses global `AdminSessionGuard`. There are no provider tokens, aliases or injectable dependencies on billing, family, notification or moderation capabilities. Those domains are accessed transactionally through the database and therefore do not justify Nest imports.

`WorkerModule` also registers `AdminGovernanceService` for scheduled sanction effects. That registration is intentionally process-scoped and must remain independent from the HTTP application graph.

## Decision

`AdminGovernanceCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability and relies on global core providers;
- owns the HTTP-app controller and service exactly once;
- exports nothing because no HTTP provider injects the service;
- does not merge billing, notification, moderation or scheduler ownership;
- is not imported by `WorkerModule`, which retains its separate service provider.

`admin-governance/public.ts` is the explicit named TypeScript boundary for controller, service and schemas. External source, worker, script and test consumers use this boundary; architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/exports, controller/service ownership, guard and root-negative ownership.
- Runtime composition regression verifies the controller and service share the HTTP global database/admin-access singletons.
- Worker isolation regression verifies no HTTP capability import and the retained process-scoped service provider.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Governance composition has one explicit HTTP owner without creating a platform mega-module.
- HTTP and worker service instances remain process-local as before.
- HTTP, OpenAPI, database, authorization, scheduling and worker behavior remain unchanged.
