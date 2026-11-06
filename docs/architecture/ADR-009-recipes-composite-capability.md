# ADR-009: recipes composite acyclic capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-007](ADR-007-recommendations-capability-direction.md), [ADR-008](ADR-008-allergen-intelligence-core-only-capability.md)

## Context

`RecipesService` has three business dependencies: `EntitlementsService`, `RecommendationsService` and `AllergenIntelligenceService`. Its controller additionally uses authentication and cookies from the global core runtime. `CookingService` and `ShoppingService` are real DI consumers of `RecipesService`.

All three upstream capabilities already have acyclic ownership. Recommendations imports entitlements, while allergen intelligence is core-only. None depends on recipes. This permits a composite recipes capability without `forwardRef` or duplicate providers.

## Decision

`RecipesCapabilityModule` is extracted under `src/contexts/catalog-recipes/`. It:

- imports exactly `EntitlementsCapabilityModule`, `RecommendationsCapabilityModule` and `AllergenIntelligenceCapabilityModule`;
- owns `RecipesController` and `RecipesService` exactly once;
- exports `RecipesService` because cooking and shopping consume it through DI;
- relies implicitly on global database/auth/cookie providers from `CoreRuntimeModule`;
- does not import cooking, shopping, search or recipe-workspace modules;
- introduces neither `forwardRef` nor a context-wide mega-module.

The dependency direction is:

`CookingService / ShoppingService -> RecipesCapabilityModule -> entitlements + recommendations + allergen-intelligence -> global core runtime`.

The three upstream modules must not import `RecipesCapabilityModule`. All source, shared, test and worker consumers of recipes contracts, domain policies or application classes must use the explicit named API from `recipes/public.ts`.

Extracting cooking, shopping, search or recipe-workspace composition is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `recipes`.
- Static composition regression verifies the exact three-module import list, service export, absence of reverse imports and absence of duplicate root ownership.
- Runtime regression verifies that the controller, cooking and shopping receive the same capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Recipes now has explicit composite ownership with one-way acyclic dependencies.
- The service remains exported only for its current production DI consumers.
- No HTTP, OpenAPI, database, transaction, authorization or idempotency behavior changes in this checkpoint.
