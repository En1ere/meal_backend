# ADR-056: Moderator capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-055](ADR-055-staff-session-guard-core-prerequisite.md)

## Context

After the shared `StaffSessionGuard` prerequisite moved to global core, HTTP `AppModule` still directly owned `ModeratorController`, `ModeratorService` and `ModeratorSessionGuard`. The service injects global `DatabaseService`, `RecipeLifecycleService` and optional `ContentReleasesService`. The moderator guard injects the shared global staff guard and is used only by `ModeratorController`.

There are no other DI consumers and no `WorkerModule` provider. Contracts and the pure status-transition policy are compile-time APIs used by shared OpenAPI code and tests.

## Decision

`ModeratorCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports exactly `CatalogRecipesModule` and `ContentReleasesCapabilityModule`;
- owns the controller, service and moderator-session guard exactly once;
- preserves `@Optional()` content-releases injection on the service;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and the shared staff-session guard;
- is not imported by `WorkerModule`.

`moderator/public.ts` explicitly names the existing contracts, pure transition policy, controller, service and guard. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact imports, empty exports, controller/service/guard ownership, decorator guard and root-negative ownership.
- Runtime regression verifies controller, service, moderator guard, shared staff guard, database, recipe-lifecycle and optional content-releases singleton identities.
- Worker isolation regression verifies no capability, service or guard in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Moderator workflow and its sole-purpose authorization guard have explicit acyclic ownership.
- Shared staff authentication remains in global core and optional content release behavior remains unchanged.
- HTTP, OpenAPI, database, authorization and worker behavior remain unchanged.
