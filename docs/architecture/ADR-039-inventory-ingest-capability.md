# ADR-039: Inventory-ingest capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

After Nutrition extraction, HTTP `AppModule` directly owned 31 controllers and 66 provider entries. Pro Overview is smaller by source size but remains blocked by a real injection of root-owned `AiService`. Recipe Workspace is compatible but has five injectable capability prerequisites and 1,140 source lines. Inventory ingest is the smallest safe one-controller/one-service frontier among the remaining candidates: 489 source lines versus 575 for Exports.

`InventoryIngestService` injects only global `DatabaseService` and `APP_CONFIG`; its controller injects the service and uses global `UserSessionGuard`. Table parsing, ZIP validation, the OCR HTTP client and the isolated `worker_threads` parser are internal runtime or compile-time helpers. There is no Nest OCR, media, storage or provider-token dependency, and `WorkerModule` does not own inventory ingest.

## Decision

`InventoryIngestCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports no business capability;
- owns `InventoryIngestController` and `InventoryIngestService` exactly once;
- exports nothing because there is no external production DI consumer;
- relies on global core for database, application config and session guard providers;
- does not import or merge OCR, media, storage or Inventory Nest capabilities;
- introduces no `forwardRef` or Nest worker registration.

`inventory-ingest/public.ts` is the explicit named TypeScript boundary for the controller, service, contracts, parser, ZIP checker and OCR preview client. External source, script and test consumers use this boundary; architecture gates prohibit deep imports. The worker entry file remains an internal executable path rather than a public API.

## Evidence

- Static composition regression verifies exact empty imports and exports, controller, provider, guard and root-negative ownership.
- Runtime composition regression verifies controller/service identity and the existing database/config singletons.
- Worker isolation regression verifies no capability import or ingest service provider in Nest `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Inventory-ingest ownership is explicit without coupling it to provider or media capabilities.
- Existing child-worker and optional OCR-preview behavior remain internal and unchanged.
- HTTP, OpenAPI, database, authorization, limits and worker behavior remain unchanged.
