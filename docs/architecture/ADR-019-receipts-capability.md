# ADR-019: Receipts capability and transaction-function boundary

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-018](ADR-018-pro-access-capability.md)

## Context

Receipt and purchase-resolution HTTP behavior belongs to the `inventory-commerce` bounded context. `ReceiptsController` consumes `ReceiptsService`; `PurchasesController` consumes `PurchasesService`. Both services inject the global core database provider and `EntitlementsService`; receipt creation additionally injects `ProAccessService`.

`purchase.store.ts` contains transaction functions for purchase review, commit and stock intake. It is not an injectable repository, provider or token. Shopping reuses the review and commit functions plus their contracts at compile time. Inventory decimal helpers and cooking/shopping contract models are likewise compile-time dependencies, not Nest providers.

No HTTP application service outside the two receipts controllers injects either service. Worker composition has no receipts provider.

## Decision

`ReceiptsCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports exactly `EntitlementsCapabilityModule` and `ProAccessCapabilityModule`;
- owns `ReceiptsController`, `PurchasesController`, `ReceiptsService` and `PurchasesService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- keeps purchase store implementation as ordinary transaction functions rather than ceremonial Nest providers/tokens;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- does not import shopping, inventory or cooking capabilities for compile-time dependencies;
- introduces no `forwardRef` or reverse capability dependency.

`receipts/public.ts` is the explicit named TypeScript boundary. It exposes the controllers/services needed by composition and tests, response/request schemas required externally, and only the review/commit transaction functions already reused by shopping. Intake implementation remains internal.

Worker composition remains independent and must not import or instantiate the receipts capability.

Extracting diary or meal-plan is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `receipts`.
- Static composition regression verifies exact imports/controllers/providers/empty exports, no root duplicates, no compile-time-only capability imports and worker isolation.
- Runtime composition regression verifies both controllers and injected entitlements/pro-access dependencies receive the expected capability-owned/global singleton instances.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Receipt ownership and dependency direction are explicit and acyclic.
- Shopping retains transaction-function reuse without a false Nest dependency.
- No HTTP, OpenAPI, database, transaction, entitlement, purchase or receipt behavior changes in this checkpoint.
