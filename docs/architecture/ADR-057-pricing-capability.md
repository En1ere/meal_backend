# ADR-057: Pricing capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned independent finance and pricing controller/service pairs. `PricingService` injects only global `DatabaseService` and extracted `ProAccessService`; `PricingController` uses global `UserSessionGuard`.

`FinanceService` does not inject pricing and `PricingService` does not inject finance. They share compile-time contracts but have independent HTTP DI boundaries. There are no other pricing DI consumers, provider tokens, optional dependencies or `WorkerModule` providers.

## Decision

Extract only the smallest safe slice as `PricingCapabilityModule` under `src/contexts/inventory-commerce/`. It:

- imports exactly `ProAccessCapabilityModule`;
- owns `PricingController` and `PricingService` exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and user-session guard;
- leaves `FinanceController` and `FinanceService` root-owned for a later checkpoint;
- is not imported by `WorkerModule`.

`finance/public.ts` explicitly names the shared finance/pricing contracts and both existing controller/service APIs. External consumers use this boundary while only pricing runtime ownership moves in this checkpoint.

## Evidence

- Static composition regression verifies exact import, empty exports, pricing controller/service ownership, guard and root-negative ownership.
- Runtime regression verifies controller, service, database and pro-access singleton identities.
- Worker isolation regression verifies no pricing capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Pricing gains explicit acyclic ownership without prematurely bundling the larger finance surface.
- Shared compile-time contracts remain explicit and Finance runtime ownership remains unchanged.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
