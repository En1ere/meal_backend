# ADR-058: Finance capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-057](ADR-057-pricing-capability.md)

## Context

After pricing extraction, HTTP `AppModule` still directly owned `FinanceController` and `FinanceService`. The service injects only global `DatabaseService` and extracted `ProAccessService`; the controller uses global `UserSessionGuard`.

The controller imports inventory `requireVersion` as a compile-time HTTP validation helper. It does not inject an inventory provider, so this dependency must not become a Nest module import. There are no other finance DI consumers, provider tokens, optional dependencies or `WorkerModule` providers.

## Decision

`FinanceCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports exactly `ProAccessCapabilityModule`;
- owns `FinanceController` and `FinanceService` exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and user-session guard;
- does not import `InventoryCapabilityModule` for the compile-time helper;
- leaves `PricingCapabilityModule` unchanged;
- is not imported by `WorkerModule`.

The existing explicit `finance/public.ts` remains the shared contract/runtime boundary.

## Evidence

- Static composition regression verifies exact import, empty exports, finance controller/service ownership, guard and root-negative ownership.
- Runtime regression verifies controller, service, database and pro-access singleton identities.
- Worker isolation regression verifies no finance capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Finance and pricing now have independent acyclic runtime ownership while retaining shared compile-time contracts.
- Inventory validation remains a compile-time dependency rather than false Nest coupling.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
