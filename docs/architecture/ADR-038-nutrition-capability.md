# ADR-038: Nutrition capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-018](ADR-018-pro-access-capability.md), [ADR-013](ADR-013-legal-consents-capability.md)

## Context

HTTP `AppModule` directly owned `NutritionController` and `NutritionService`. The service injects global `DatabaseService`, `ProAccessService` and `LegalConsentService`; the controller injects only the service and uses global `UserSessionGuard`.

Nutrition also imports diary aggregation functions and types, plus inventory version/schema helpers. These are compile-time domain dependencies rather than Nest providers. It has no Meal Plan runtime dependency. No production provider injects `NutritionService`, and worker composition does not own it.

## Decision

`NutritionCapabilityModule` is extracted under `src/contexts/planning-health/`. It:

- imports exactly `ProAccessCapabilityModule` and `LegalConsentsCapabilityModule`;
- owns `NutritionController` and `NutritionService` exactly once;
- exports nothing because there is no external production DI consumer;
- relies on global core for database and session guard providers;
- does not import or merge Diary, Meal Plan or Inventory Nest capabilities;
- introduces no `forwardRef`, worker registration or reverse dependency.

`nutrition/public.ts` is the explicit named TypeScript boundary for the controller, service, schemas, types and pure projection functions. External source and test consumers use this boundary; architecture gates prohibit deep imports.

## Evidence

- Static composition regression verifies exact imports, controllers, providers, exports, guard and root-negative ownership.
- Runtime composition regression verifies controller/service identity and the existing Pro Access and legal-consent singletons.
- Worker isolation regression verifies no capability import or nutrition service provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Nutrition ownership and its runtime dependency direction are explicit and acyclic.
- Diary and Inventory remain compile-time model/helper dependencies only; Meal Plan remains independent.
- HTTP, OpenAPI, database, authorization, Pro access, consent and worker behavior remain unchanged.
