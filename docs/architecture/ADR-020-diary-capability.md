# ADR-020: Diary capability and process-scoped maintenance worker

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-013](ADR-013-legal-consents-capability.md), [ADR-018](ADR-018-pro-access-capability.md)

## Context

Diary HTTP behavior belongs to the `planning-health` bounded context. `DiaryController` consumes `DiaryService`. The service injects the global core database provider, `ProAccessService` and `LegalConsentService`. `MealPlanService` is the only other HTTP DI consumer.

Diary source imports inventory decimal helpers, while nutrition reuses diary contracts and pure aggregation functions. These are compile-time dependencies, not Nest providers.

`WorkerModule` is a separate process composition root. It owns its own `DiaryService` for due portion maintenance, together with worker-owned database, pro-access and legal-consent providers. An HTTP singleton cannot and must not be shared across processes.

## Decision

`DiaryCapabilityModule` is extracted under `src/contexts/planning-health/`. It:

- imports exactly `ProAccessCapabilityModule` and `LegalConsentsCapabilityModule`;
- owns `DiaryController` and `DiaryService` exactly once in HTTP composition;
- exports only `DiaryService` for the current `MealPlanService` consumer;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- does not import inventory or nutrition capabilities for compile-time dependencies;
- introduces no `forwardRef` or reverse capability dependency.

`diary/public.ts` is the explicit named TypeScript boundary for worker composition, scheduled scripts, meal-plan DI, shared schemas, nutrition projections and tests.

`WorkerModule` retains a separate process-scoped `DiaryService` through the public API and must not import the HTTP capability. Worker diary receives the worker-owned pro-access and legal-consent instances.

Extracting meal-plan is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `diary`.
- Static composition regression verifies exact imports/controller/provider/export, no root duplicate and worker isolation.
- HTTP runtime regression verifies controller and meal-plan receive the same capability-owned diary singleton and its shared pro-access/legal dependencies.
- Worker runtime regression verifies worker diary receives worker-owned pro-access and legal-consent providers.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Diary ownership is explicit and meal-plan is unblocked for a later checkpoint.
- HTTP and worker diary instances remain intentionally process-local.
- Compile-time inventory/nutrition relationships do not become false Nest dependencies.
- No HTTP, OpenAPI, database, consent, pro-access, portion or diary behavior changes in this checkpoint.
