# ADR-016: Shopping capability and compile-time commerce dependencies

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-009](ADR-009-recipes-composite-capability.md)

## Context

Shopping list HTTP behavior belongs to the `inventory-commerce` bounded context. `ShoppingController` consumes `ShoppingService`. The service injects the global core database provider, `RecipesService` and `EntitlementsService`.

The implementation also imports inventory decimal helpers, cooking quantity contracts and receipt purchase functions/contracts. These are compile-time public models and functions, not injected providers. No HTTP application service outside the shopping controller injects `ShoppingService`, and worker composition has no shopping provider.

## Decision

`ShoppingCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports exactly `RecipesCapabilityModule` and `EntitlementsCapabilityModule`;
- owns `ShoppingController` and `ShoppingService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- does not import inventory, cooking or receipts capabilities for compile-time dependencies;
- introduces no `forwardRef` or reverse capability dependency.

`shopping/public.ts` is the explicit named TypeScript boundary for shared response schemas and tests. Source-level visibility does not imply a Nest export.

Worker composition remains independent and must not import or instantiate the shopping capability.

Extracting receipts, meal-plan or another commerce capability is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `shopping`.
- Static composition regression verifies exact imports/controller/provider/empty exports, no root duplicates, no inventory/cooking/receipts Nest imports and worker isolation.
- Runtime composition regression verifies the controller and injected recipes/entitlements dependencies share the capability-owned singleton instances.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Shopping ownership and runtime dependency direction are explicit and acyclic.
- Compile-time inventory/cooking/receipts relationships remain accurately represented without artificial Nest imports.
- No HTTP, OpenAPI, database, transaction, entitlement or shopping behavior changes in this checkpoint.
