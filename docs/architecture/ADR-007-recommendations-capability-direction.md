# ADR-007: recommendations capability dependency direction

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`recommendations` belongs to the `planning-health` bounded context. Its application service depends on the global database runtime and `EntitlementsService`. At the same time, `PersonalizationService` and `RecipesService` are real DI consumers of `RecommendationsService`.

Leaving all three services in the root module hides ownership and makes their singleton relationship accidental. Importing personalization or recipes into recommendations would reverse the actual dependency direction and create pressure toward the existing product context SCC.

## Decision

`RecommendationsCapabilityModule` is extracted under `src/contexts/planning-health/`. It:

- explicitly imports `EntitlementsCapabilityModule`;
- owns `RecommendationsController` and `RecommendationsService` exactly once;
- exports `RecommendationsService` because personalization and recipes consume it through DI;
- relies on global database and session-guard providers from `CoreRuntimeModule`;
- does not import personalization, recipes or allergen capabilities;
- introduces neither `forwardRef` nor a context-wide mega-module.

The dependency direction is therefore:

`AppModule consumers (personalization, recipes) -> RecommendationsCapabilityModule -> EntitlementsCapabilityModule -> global core runtime`.

All source, shared, test and worker consumers of recommendation contracts, domain policies or application classes must import the explicit named API from `recommendations/public.ts`. The root HTTP module imports the capability and no longer declares its controller/service.

Extracting allergen or recipes composition, or changing recommendation policies and persistence, is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `recommendations`.
- Static composition regression requires the explicit entitlements import and service export while rejecting duplicate root ownership.
- Runtime regression verifies that the controller, personalization and recipes receive the same capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- Recommendation ownership and its downstream consumers are explicit without a Nest cycle.
- The service remains exported only because there are current production DI consumers.
- No HTTP, OpenAPI, database, transaction, authorization or idempotency behavior changes in this checkpoint.
