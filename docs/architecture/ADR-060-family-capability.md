# ADR-060: Family capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `FamilyController` and `FamilyService`. The service injects only global `DatabaseService` and `EntitlementsService`; the controller uses global `UserSessionGuard`.

Family chat and family notes do not inject or import the family service or contracts and already have separate capability ownership. A live PostgreSQL acceptance script resolves `FamilyService` through the normal non-strict application graph. There are no provider tokens, optional dependencies or `WorkerModule` providers.

## Decision

`FamilyCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns the controller and service exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and user-session guard;
- keeps family chat and family notes as independent capabilities;
- is not imported by `WorkerModule`.

`family/public.ts` explicitly names the existing contracts, pure successor policy, controller and service required by source, acceptance scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact import, empty exports, controller/service ownership, guard and root-negative ownership.
- Runtime regression verifies controller, service, database and entitlements singleton identities.
- Worker isolation regression verifies no capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Family lifecycle gains explicit acyclic ownership without absorbing chat or notes.
- Pure successor selection and live acceptance resolution remain compatible public APIs.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
