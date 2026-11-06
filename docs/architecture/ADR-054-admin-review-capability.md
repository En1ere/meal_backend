# ADR-054: Admin-review capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminReviewController`, `AdminReviewService` and `AdminRollbackRegistry`. The service injects global `DatabaseService`, global `AdminAccessService` and the registry. The registry injects only `ContentReleasesService`; the controller uses global `AdminSessionGuard`.

There are no external HTTP DI consumers. An acceptance script constructs the registry directly with a content-releases service, and tests consume contracts and the pure preview policy. No provider is owned by `WorkerModule`.

## Decision

`AdminReviewCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports exactly `ContentReleasesCapabilityModule`;
- owns the controller, service and rollback registry exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database, admin access and admin-session guard;
- keeps content release rollback behind the existing registry instead of importing moderation or other domains;
- is not imported by `WorkerModule`.

`admin-review/public.ts` explicitly names the existing contracts, pure policy, controller, service and registry API used by source, acceptance scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact import, empty exports, controller/service/registry ownership, guard and root-negative ownership.
- Runtime regression verifies controller, service, registry, database, admin-access and content-releases singleton identities.
- Worker isolation regression verifies no capability or provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Admin review and its bounded rollback registry have explicit acyclic ownership without becoming a moderation mega-module.
- Acceptance construction and pure preview policy remain explicit compile-time APIs.
- HTTP, OpenAPI, database, authorization, rollback and worker behavior remain unchanged.
