# ADR-036: Personalization capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-007](ADR-007-recommendations-capability-direction.md), [ADR-013](ADR-013-legal-consents-capability.md)

## Context

After provider-runtime extraction, HTTP `AppModule` directly owned 34 controllers and 69 provider entries. Among the unextracted user-facing frontiers, personalization is the smallest cohesive surface: three source files and 362 lines, one controller and one service. Comparable family chat has 539 lines; nutrition 543; recipe workspace 1,140; finance 1,324; and subscription settings 2,128.

`PersonalizationService` injects global `DatabaseService`, `RecommendationsService` and `LegalConsentService`. Its controller injects the service and uses global `UserSessionGuard`. Recommendations and legal consents already have exported acyclic capabilities. No production provider injects `PersonalizationService`, and worker composition does not own it.

## Decision

`PersonalizationCapabilityModule` is extracted under `src/contexts/planning-health/`. It:

- imports exactly `RecommendationsCapabilityModule` and `LegalConsentsCapabilityModule`;
- owns `PersonalizationController` and `PersonalizationService` exactly once;
- exports nothing because there is no external production DI consumer;
- relies on global core for database and session guard providers;
- introduces no `forwardRef`, worker registration or reverse dependency.

`personalization/public.ts` is the explicit named TypeScript boundary for the controller, service, schemas, catalog and pure allergen-change predicate. External source, test and acceptance-script consumers use this boundary; deep imports are prohibited by architecture gates.

## Evidence

- Static composition regression verifies exact imports, controllers, providers, exports, guard and root-negative ownership.
- Runtime composition regression verifies controller/service identity and the existing recommendation/legal-consent singleton dependencies.
- Worker isolation regression verifies no capability import or personalization service provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Personalization ownership and its dependency direction are explicit and acyclic.
- Compile-time consumers retain named access without exposing a Nest provider export.
- HTTP, OpenAPI, database, authorization, idempotency and worker behavior remain unchanged.
