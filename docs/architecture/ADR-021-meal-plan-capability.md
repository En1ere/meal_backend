# ADR-021: Meal plan capability and compile-time planning inputs

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-020](ADR-020-diary-capability.md)

## Context

Meal planning and prepared-portion HTTP behavior belongs to the `planning-health` bounded context. `MealPlanController` and `PortionsController` both consume `MealPlanService`. The service injects the global core database provider, `EntitlementsService` and `DiaryService`.

The implementation also uses recipe scaling/nutrition schemas and inventory decimal/quantity contracts. These are compile-time functions and models, not injected providers. Recommendation and nutrition services are not constructor dependencies. No HTTP application service outside the two controllers injects `MealPlanService`, and worker composition has no meal-plan provider.

## Decision

`MealPlanCapabilityModule` is extracted under `src/contexts/planning-health/`. It:

- imports exactly `EntitlementsCapabilityModule` and `DiaryCapabilityModule`;
- owns `MealPlanController`, `PortionsController` and `MealPlanService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- does not import recipes, inventory, recommendations or nutrition capabilities for compile-time dependencies;
- introduces no `forwardRef` or reverse capability dependency.

`meal-plan/public.ts` is the explicit named TypeScript boundary for composition, shared response schemas, planning contracts and pure date-range functions used by tests.

Worker composition remains independent and must not import or instantiate the meal-plan capability.

## Evidence

- Architecture gates reject external deep imports into `meal-plan`.
- Static composition regression verifies exact imports/controllers/provider/empty exports, no root duplicates, no compile-time-only capability imports and worker isolation.
- Runtime composition regression verifies both controllers and injected entitlements/diary dependencies receive the expected singleton instances.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Meal-plan ownership and dependency direction are explicit and acyclic.
- Recipe/inventory planning helpers do not create false Nest dependencies.
- No HTTP, OpenAPI, database, transaction, entitlement, diary, plan or portion behavior changes in this checkpoint.
