# ADR-015: Cooking capability, compile-time dependencies and worker isolation

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-009](ADR-009-recipes-composite-capability.md), [ADR-012](ADR-012-operational-runtime-capability.md), [ADR-014](ADR-014-content-releases-capability.md)

## Context

Cooking HTTP behavior belongs to the `catalog-recipes` bounded context. `CookingController` and `CookingStatisticsController` both consume `CookingService`. The service uses global core database/session providers, `RecipesService`, `ContentReleasesService`, and its local lifecycle/statistics-policy providers. `CookingLifecycleService` uses the global config/database providers and `WorkerRuntimeFactory`.

Cooking source also imports inventory decimal helpers and the preserve consumption function. These are compile-time public APIs, not injected providers. Turning them into Nest module imports would overstate the runtime graph. No HTTP application service outside the cooking controllers injects a cooking provider.

The separate `WorkerModule` owns a process-scoped `CookingLifecycleService` for scheduled execution. It must not import the HTTP capability.

## Decision

`CookingCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- imports exactly `RecipesCapabilityModule`, `OperationalRuntimeCapabilityModule` and `ContentReleasesCapabilityModule`;
- owns `CookingController`, `CookingStatisticsController`, `CookingService`, `CookingLifecycleService` and `CookingStatisticsPolicy` exactly once in HTTP composition;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core providers without importing `CoreRuntimeModule` again;
- does not import inventory or preserves capabilities because their dependencies are compile-time functions/models;
- introduces no `forwardRef` or reverse capability dependency.

`cooking/public.ts` is the explicit named TypeScript boundary for worker composition, scheduled-task lookup, shared response schemas, dependent contracts and tests. Source-level visibility does not imply a Nest export.

`WorkerModule` continues to create its own lifecycle provider through the public API and remains process-isolated.

Extracting shopping, meal-plan or another consumer is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `cooking`.
- Static composition regression verifies exact imports/controllers/providers/empty exports, no root duplicates, absence of inventory/preserves Nest imports and worker isolation.
- Runtime composition regression verifies both controllers and all local/inbound provider dependencies share the capability-owned singleton instances.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Cooking ownership and runtime dependency direction are explicit and acyclic.
- Compile-time inventory/preserve dependencies remain accurately represented as public TypeScript imports.
- HTTP and worker lifecycle instances remain intentionally separate.
- No HTTP, OpenAPI, database, transaction, reminder, publication or cooking behavior changes in this checkpoint.
