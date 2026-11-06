# ADR-041: Critical-reauth capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`CriticalReauthService` was directly owned by HTTP `AppModule`. It is injected by `AccountLifecycleController`, `AccountLifecycleService` and `ExportsService`. Its constructor requires only global core providers: `DatabaseService`, `AuthService` and `APP_CONFIG`.

The missing child-module owner blocked extraction of Exports: an imported capability cannot consume a provider owned only by its parent `AppModule`. Worker composition does not register critical reauthentication.

## Decision

`CriticalReauthCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability and relies only on global core;
- owns `CriticalReauthService` exactly once in the HTTP application;
- exports the service because Account Lifecycle and Exports are real DI consumers;
- declares no controller;
- introduces no `forwardRef`, worker registration or broader Account Lifecycle extraction.

`account-lifecycle/public.ts` is the explicit named TypeScript boundary for current lifecycle controllers, service, critical reauthentication and their contracts. External source, script and test consumers use this boundary; architecture gates prohibit deep imports. The internal source-inspection regression may still reference the implementation file as data rather than import it.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider, export and root-negative ownership.
- Runtime composition regression verifies one service singleton across the lifecycle controller, lifecycle service and Exports service.
- Worker isolation regression verifies no capability import or critical-reauth provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Critical reauthentication now has a reusable acyclic owner without merging Account Lifecycle.
- Exports capability extraction is unblocked for a later checkpoint.
- HTTP, OpenAPI, database, authentication, token and worker behavior remain unchanged.
