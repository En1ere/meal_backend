# ADR-051: Admin-content capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `AdminContentController` and `AdminContentService`. The service injects global `DatabaseService` and `AdminAccessService`, `RecipeLifecycleService`, and optional `ContentReleasesService`; the controller uses global `AdminSessionGuard`.

Neither the rollback registry nor moderator services inject `AdminContentService`. The live PostgreSQL acceptance script resolves the service from the normal application context with `app.get`. Comparison and not-duplicate policies plus content contracts are compile-time APIs. There is no `WorkerModule` provider.

## Decision

`AdminContentCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports exactly `CatalogRecipesModule` and `ContentReleasesCapabilityModule`;
- owns the controller and service exactly once;
- preserves optional content-releases injection while retaining the current HTTP provider;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database, admin access and admin-session guard;
- does not merge moderator, admin review or rollback ownership;
- is not imported by `WorkerModule`.

`admin-content/public.ts` explicitly names the contracts, pure comparison policies, controller and service required by source, acceptance scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact imports, controller/service, empty exports, guard and root-negative ownership.
- Runtime regression verifies controller/service identity and the unchanged database, admin-access, recipe-lifecycle and optional content-releases singletons.
- Worker isolation regression verifies no capability or service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Admin content workflow has explicit acyclic ownership without becoming a moderation/admin mega-module.
- Pure catalog comparison policies remain compile-time APIs.
- HTTP, OpenAPI, database, authorization, lifecycle, rollback and acceptance behavior remain unchanged.
