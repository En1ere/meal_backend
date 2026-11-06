# ADR-005: inventory capability composition boundary

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`inventory` belongs to the `inventory-commerce` bounded context, which is still part of the product context SCC described in ADR-004. Its current HTTP service depends on the database runtime and `EntitlementsService`. The database runtime is globally provided by `CoreRuntimeModule`; entitlements already has a small acyclic capability module.

## Decision

`InventoryCapabilityModule` is extracted under `src/contexts/inventory-commerce/` as the next intermediate capability boundary. It:

- explicitly imports `EntitlementsCapabilityModule`;
- owns `InventoryController` and `InventoryService` exactly once;
- keeps `InventoryService` private because there is no production DI consumer outside its controller;
- relies on the global core runtime for database and session-guard dependencies;
- introduces neither `forwardRef` nor a context-wide mega-module.

All source, shared, test and worker consumers of inventory contracts, domain helpers or application services must import `inventory/public.ts`. The HTTP root module imports the capability and no longer declares the inventory controller/service.

`inventory-ingest` remains independently composed in `AppModule`. Decomposing the large `InventoryService`, changing repositories or extracting other inventory-commerce capabilities is explicitly outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `inventory`.
- Static composition regression rejects duplicate root ownership and requires the capability import.
- Runtime regression verifies that the controller receives the capability-owned service instance without exporting it.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Inventory has an explicit acyclic Nest ownership boundary without changing HTTP, OpenAPI, database, transaction, authorization or idempotency behavior.
- The `inventory-commerce` bounded context is not yet fully extracted; only the inventory capability has moved.
- A later checkpoint may split application/domain/infrastructure responsibilities only with separate behavior-preserving evidence.
