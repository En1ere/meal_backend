# ADR-059: Subscription-settings capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `SubscriptionSettingsController` and `SubscriptionSettingsService`. The service injects only global `DatabaseService` and `EntitlementsService`; the controller uses global `UserSessionGuard`.

Subscription quotes, allowances, prices and lifecycle transitions are local pure compile-time policy. Payment and admin-billing providers or tokens are not injected. A live PostgreSQL acceptance script resolves the service through the normal non-strict application graph. There is no `WorkerModule` provider.

## Decision

`SubscriptionSettingsCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns the controller and service exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and user-session guard;
- does not import or merge payment and admin-billing infrastructure;
- is not imported by `WorkerModule`.

`subscription-settings/public.ts` explicitly names the existing contracts, pure lifecycle policy, controller and service required by source, acceptance scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact import, empty exports, controller/service ownership, guard and root-negative ownership.
- Runtime regression verifies controller, service, database and entitlements singleton identities.
- Worker isolation regression verifies no capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Subscription settings gain explicit acyclic ownership without coupling to payment infrastructure.
- Pure lifecycle policy remains a compile-time public API and live acceptance resolution remains compatible.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
