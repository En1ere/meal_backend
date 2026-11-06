# ADR-014: Content releases capability and reputation helper boundary

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-013](ADR-013-legal-consents-capability.md)

## Context

Content release publication and author achievement reads belong to the `community-content` bounded context. Both HTTP controllers use `ContentReleasesService`. The service depends on the global core database/admin-access providers and on `LegalConsentService` for consent enforcement.

Five HTTP application services consume `ContentReleasesService`: admin content, rollback registry, cooking, moderation and recipe workspace. `ReputationAchievementsService` is an internal helper created by `ContentReleasesService`; it is not a Nest provider and has no independent DI consumer. Worker composition has no content-release consumer.

## Decision

`ContentReleasesCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports exactly `LegalConsentsCapabilityModule`;
- relies on global core providers without importing `CoreRuntimeModule` again;
- owns `ContentReleasesController`, `AchievementsController` and `ContentReleasesService` exactly once;
- exports only `ContentReleasesService` for the five current HTTP DI consumers;
- keeps reputation/achievement projection implementation internal and does not promote its helper to a Nest provider;
- introduces no `forwardRef` and no reverse capability dependency.

`content-releases/public.ts` is the explicit named TypeScript boundary for the controllers, service and response schemas required by shared OpenAPI wiring. It does not expose internal reputation policy or helper implementation.

Worker composition remains independent and must not import the HTTP capability or create a content-release provider.

Extracting cooking or any other consumer is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `content-releases`.
- Static composition regression verifies exact imports/controllers/providers/exports, no root duplicates and worker isolation.
- Runtime composition regression verifies both controllers and all five HTTP consumers receive the same capability-owned service.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Content release ownership and its legal-consent dependency are explicit and acyclic.
- Reputation/achievement logic remains an implementation detail instead of becoming a ceremonial DI layer.
- No HTTP, OpenAPI, database, consent, publication or achievement behavior changes in this checkpoint.
