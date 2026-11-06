# ADR-062: AI HTTP capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-061](ADR-061-ai-provider-prerequisite.md)

## Context

After extracting the config-only AI provider prerequisite, HTTP `AppModule` still directly owned `AiController`, `AiService` and the embedded `AiReconciliationService` lifecycle. `AiService` injects global `DatabaseService`, `AiProvider`, `EntitlementsService` and `LegalConsentService`. Reconciliation injects global database/configuration, the same `AiService` and `WorkerRuntimeFactory`.

`ProOverviewService` is the only production DI consumer outside AI and requires the same HTTP-application `AiService` singleton. The live PostgreSQL script also resolves that service through the non-strict application graph. AI has no provider-observer dependency, token alias or optional injection. `WorkerModule` owns none of the AI providers and must remain process-isolated.

## Decision

`AiCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports exactly `AiProviderCapabilityModule`, `EntitlementsCapabilityModule`, `LegalConsentsCapabilityModule` and `OperationalRuntimeCapabilityModule`;
- owns `AiController`, `AiService` and `AiReconciliationService` exactly once;
- exports only `AiService` for the existing Pro overview consumer;
- relies on global core for database, configuration and `UserSessionGuard`;
- does not import provider observation or telemetry directly because reconciliation observes work through `WorkerRuntimeFactory`;
- is not imported by `WorkerModule` and does not absorb Pro overview.

## Evidence

- Static composition regression verifies exact imports, ownership, export, guard and root-negative ownership.
- Runtime regression verifies controller/service, provider, entitlements, legal-consent, worker-runtime and Pro overview singleton identities.
- Worker isolation regression verifies no AI HTTP capability or provider ownership in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- AI HTTP orchestration and its reconciliation lifecycle now have explicit acyclic ownership.
- Pro overview continues to consume the exported HTTP singleton and remains a separate later capability.
- HTTP, OpenAPI, database, provider fail-closed policy and process topology remain unchanged.
