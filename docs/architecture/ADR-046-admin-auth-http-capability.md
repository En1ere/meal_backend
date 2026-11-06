# ADR-046: Admin-auth HTTP capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminAuthController`. The controller injects only global `AuthService`, `AuthCookies` and `AdminAccessService`; protected methods use global `AdminSessionGuard`. It has no capability-local provider.

The same source module also contains core/runtime concerns with distinct ownership: `CoreRuntimeModule` owns and exports `AdminAccessService` and `AdminSessionGuard`, root composition retains `AdminReadBoundary` and the global `AdminNetworkGuard` binding, and `WorkerModule` owns a separate process-scoped `AdminAccessService`. Combining those owners into one capability would change scopes or create a broad identity/runtime module.

## Decision

`AdminAuthCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability;
- owns only `AdminAuthController`;
- declares and exports no providers;
- relies on global core for auth, cookies, access and session guard;
- does not own `AdminReadBoundary`, `AdminNetworkGuard`, core providers or worker providers;
- is not imported by `WorkerModule`.

`admin-auth/public.ts` explicitly names the controller, guards, services, boundary, schemas and recovery API required by existing source, scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/providers/exports, controller-only ownership, protected-method guards and root-negative ownership.
- Runtime regression verifies the controller receives the global auth, cookies and access singletons.
- Worker isolation regression verifies no HTTP capability/controller import while the existing process-scoped access service remains intact.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Admin authentication HTTP ownership is explicit without merging core, read-boundary, network or worker scopes.
- The explicit public boundary removes deep imports without changing runtime ownership.
- HTTP, OpenAPI, database, authentication and worker behavior remain unchanged.
