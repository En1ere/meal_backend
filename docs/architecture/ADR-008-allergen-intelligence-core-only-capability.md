# ADR-008: allergen intelligence as a core-only capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`allergen-intelligence` belongs to the `catalog-recipes` bounded context. Its application service depends only on `DatabaseService`; its user and admin controllers use session guards. These dependencies are all globally provided by `CoreRuntimeModule`.

`RecipesService` is a real DI consumer of `AllergenIntelligenceService`. Allergen intelligence does not depend on recipes, so importing a recipes capability in the opposite direction would misrepresent the source dependency and create pressure toward a Nest cycle.

## Decision

`AllergenIntelligenceCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- owns `AdminAllergensController`, `AllergenReportController` and `AllergenIntelligenceService` exactly once;
- imports no business capability module;
- relies only on global database and session-guard providers from `CoreRuntimeModule`;
- exports `AllergenIntelligenceService` because recipes consumes it through DI;
- introduces neither `forwardRef` nor a context-wide mega-module.

The dependency direction is:

`RecipesService -> AllergenIntelligenceCapabilityModule -> global core runtime`.

All source, shared, test and worker consumers of allergen contracts or application classes must import the explicit named API from `allergen-intelligence/public.ts`. The root HTTP module imports the capability and no longer declares either controller or the service.

Extracting recipes composition, changing allergen projection/persistence or adding other catalog capabilities is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `allergen-intelligence`.
- Static composition regression verifies no business imports, the required service export and absence of duplicate root ownership.
- Runtime regression verifies that both controllers and recipes receive the same capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Allergen intelligence has explicit core-only ownership and a one-way recipes consumer edge.
- The service remains exported only for its current production DI consumer.
- No HTTP, OpenAPI, database, transaction, authorization or idempotency behavior changes in this checkpoint.
