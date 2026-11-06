# ADR-063: Pro overview capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-062](ADR-062-ai-capability.md)

## Context

After AI became an exported capability, HTTP `AppModule` still directly owned `ProOverviewController` and `ProOverviewService`. The service injects global `DatabaseService`, `ProAccessService` and `AiService`; the controller uses global `UserSessionGuard`.

There is no production DI consumer outside the controller. A live PostgreSQL acceptance script resolves `ProOverviewService` through the non-strict application graph. `WorkerModule` owns a separate process-scoped `ProAccessService`, but owns no Pro overview controller or service.

## Decision

`ProOverviewCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `AiCapabilityModule` and `ProAccessCapabilityModule`;
- owns `ProOverviewController` and `ProOverviewService` exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and `UserSessionGuard`;
- is not imported by `WorkerModule` and does not change its process-scoped Pro access provider.

The existing explicit `pro-overview/public.ts` remains the compile-time boundary for contracts, pure projection, acceptance scripts and tests.

## Evidence

- Static composition regression verifies exact imports, ownership, empty exports, guard and root-negative ownership.
- Runtime regression verifies controller/service, database, AI and Pro access singleton identities.
- Worker isolation regression verifies no HTTP capability or Pro overview service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Pro overview gains explicit acyclic ownership without absorbing AI or the reusable Pro access prerequisite.
- The worker's process-scoped Pro access composition remains unchanged.
- HTTP, OpenAPI, database and runtime behavior remain unchanged.
