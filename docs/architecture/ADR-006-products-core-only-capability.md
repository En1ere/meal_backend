# ADR-006: products as a core-only capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`products` belongs to the `catalog-recipes` bounded context, but its current runtime DI graph does not depend on recipes, search, inventory or another business capability. `ProductsService` depends only on `DatabaseService`; `ProductsController` additionally uses the user-session guard. Both dependencies are provided globally by `CoreRuntimeModule`.

Adding a business-module import merely because two capabilities share a future bounded context would create coupling that the implementation does not require. Merging products into the existing recipe-policy composition module would also broaden that module before the surrounding context edges are ready to converge.

## Decision

`ProductsCapabilityModule` is extracted as a small core-only capability under `src/contexts/catalog-recipes/`. It:

- owns `ProductsController` and `ProductsService` exactly once;
- imports no business capability module;
- relies only on global database and session-guard providers from `CoreRuntimeModule`;
- keeps `ProductsService` private because there is no production DI consumer outside its controller;
- introduces neither `forwardRef` nor a context-wide mega-module.

All source, shared, test and worker consumers of products contracts or application classes must import the explicit named API from `products/public.ts`. The root HTTP module imports the capability and no longer declares the products controller/service.

Recipes, search and inventory-ingest composition remains unchanged. Consolidating the two catalog capability modules is deferred until their actual dependency edges support an acyclic bounded-context module.

## Evidence

- Architecture gates reject external deep imports into `products`.
- Static composition regression requires the capability import, verifies that it has no business imports or service export, and rejects duplicate root ownership.
- Runtime regression verifies that the controller receives the capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Products now has explicit ownership without an artificial dependency on another business capability.
- `catalog-recipes` remains a bounded-context target represented temporarily by multiple small acyclic capability modules.
- No HTTP, OpenAPI, database, transaction, authorization or idempotency behavior changes in this checkpoint.
