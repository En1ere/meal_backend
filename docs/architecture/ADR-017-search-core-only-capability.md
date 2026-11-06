# ADR-017: Core-only search capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Search HTTP behavior belongs to the `catalog-recipes` bounded context. `SearchController` consumes `SearchService`. The service injects only the global core database provider, while the controller uses the global user-session guard.

Search source imports `publicRecipeImage` from the recipes public API. This is a pure projection helper, not an injected provider, and must not create a `RecipesCapabilityModule` Nest dependency. No HTTP application service outside the search controller injects `SearchService`, and worker composition has no search provider.

Receipts and meal-plan were also considered for this checkpoint. Receipts still injects root/worker-shared `ProAccessService`; meal-plan injects root/worker-shared `DiaryService`. Extracting either first would require a separate prerequisite capability or mixed ownership, so search is the smaller acyclic frontier.

## Decision

`SearchCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- imports no business capability;
- owns `SearchController` and `SearchService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- does not import `RecipesCapabilityModule` for a compile-time projection helper;
- introduces no `forwardRef` or reverse capability dependency.

`search/public.ts` is the explicit named TypeScript boundary for the shared OpenAPI response schema. Source-level visibility does not imply a Nest export.

Worker composition remains independent and must not import or instantiate the search capability.

## Evidence

- Architecture gates reject external deep imports into `search`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Search ownership is explicit without overstating its compile-time recipes dependency.
- Receipts and meal-plan remain staged behind their real provider prerequisites.
- No HTTP, OpenAPI, database, authorization or search behavior changes in this checkpoint.
