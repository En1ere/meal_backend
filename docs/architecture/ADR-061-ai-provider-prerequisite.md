# ADR-061: AI provider prerequisite capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The remaining AI/Pro overview root cluster cannot yet move as one capability without bundling several responsibilities. Its smallest prerequisite is `AiProvider`: it injects only global `APP_CONFIG` and is consumed only by the HTTP application's root-owned `AiService`.

`WorkerModule` owns neither `AiProvider` nor `AiService`. The provider has no token alias, database dependency, controller or background lifecycle. Payment, media, delivery and account provider chains are separate remaining concerns and must not be absorbed into an AI capability.

## Decision

`AiProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no business capability and relies only on global core configuration;
- owns and exports exactly `AiProvider` for the current root-owned `AiService` consumer;
- owns no controller and does not absorb `AiService`, `AiReconciliationService` or `ProOverviewService`;
- is not imported by `WorkerModule`;
- keeps the existing provider implementation and fail-closed behavior unchanged.

`ai/public.ts` explicitly names the existing provider, services, controller, contracts and pure policies required by source, scripts and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider/export ownership and root-negative ownership.
- Runtime regression verifies the root `AiService` receives the capability-owned singleton provider.
- Worker isolation regression verifies no AI provider capability or provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- The AI provider becomes a small acyclic prerequisite for a later AI capability extraction.
- No provider token, HTTP route, OpenAPI schema, database contract or worker process scope changes.
- The remaining root composition is reduced by one provider without prematurely combining AI orchestration or Pro overview.
