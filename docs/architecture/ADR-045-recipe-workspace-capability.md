# ADR-045: Recipe-workspace capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `RecipeWorkspaceController` and `RecipeWorkspaceService`. The service injects global `DatabaseService`, recipe policy and lifecycle services, entitlements, legal consents and an optional content-releases service. The controller uses global `UserSessionGuard`.

Recipe nutrition schemas and workspace contracts/domain helpers are compile-time dependencies only. There are no external HTTP DI consumers of the workspace service and no process-scoped workspace provider in `WorkerModule`.

## Decision

`RecipeWorkspaceCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- imports exactly `CatalogRecipesModule`, `EntitlementsCapabilityModule`, `LegalConsentsCapabilityModule` and `ContentReleasesCapabilityModule`;
- owns the controller and service exactly once;
- preserves the optional `ContentReleasesService` constructor contract while retaining the currently available HTTP provider;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database and user-session guard;
- does not import `RecipesCapabilityModule` or media/provider modules for compile-time schemas;
- is not imported by `WorkerModule`.

`recipe-workspace/public.ts` explicitly names the controller, service, schemas, types and pure domain helpers needed by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact imports, controller, provider, empty exports, guard and root-negative ownership.
- Runtime regression verifies the controller/service identity and the exact policy, lifecycle, entitlements, legal-consents, optional content-releases and database singleton identities.
- Worker isolation regression verifies no capability import or service provider.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Recipe Workspace has explicit acyclic ownership without merging adjacent recipe capabilities.
- Compile-time recipe schemas remain compile-time dependencies rather than artificial Nest edges.
- HTTP, OpenAPI, database, authorization and optional-provider behavior remain unchanged.
