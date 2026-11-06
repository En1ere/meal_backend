# ADR-010: preserves runtime versus model dependency

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`PreservesService` has one business DI dependency: `EntitlementsService`. It also uses inventory decimal/model functions through TypeScript imports, but it does not inject `InventoryService`. Treating that compile-time model dependency as a Nest module dependency would overstate runtime coupling and unnecessarily connect two capabilities.

`consumePreserveContainer` is a real compile-time application function consumed by cooking. There is no production DI consumer of `PreservesService` outside its controller.

## Decision

`PreservesCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns `PreservesController` and `PreservesService` exactly once;
- keeps `PreservesService` private;
- does not import `InventoryCapabilityModule` because inventory is only a compile-time public model dependency;
- relies implicitly on global database and user-session providers from `CoreRuntimeModule`;
- introduces neither `forwardRef` nor a context-wide mega-module.

The TypeScript public API is deliberately narrow. `preserves/public.ts` exposes only the response/QR contracts required by external consumers, the controller/service needed by composition evidence, and `consumePreserveContainer` for cooking. Internal command contracts and domain helpers remain private to the module.

The dependency directions are:

- runtime DI: `PreservesCapabilityModule -> EntitlementsCapabilityModule -> global core runtime`;
- compile time: `preserves -> inventory/public.ts` and `cooking -> preserves/public.ts`.

Extracting cooking or changing preserve persistence/transactions is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `preserves`.
- Static composition regression verifies the exact entitlements import, absence of `InventoryCapabilityModule`, private service and absence of duplicate root ownership.
- Runtime regression verifies that the controller receives the capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Nest wiring now reflects runtime dependencies rather than every compile-time model import.
- Cooking retains its existing function-level dependency without importing a Nest capability.
- No HTTP, OpenAPI, database, transaction, authorization or idempotency behavior changes in this checkpoint.
