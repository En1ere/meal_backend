# ADR-024: Core-only community feed capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The public recipe feed and comment-reading surface belongs to the `community-content` bounded context. `CommunityController` consumes `CommunityService`, and the service injects only the global core database provider. It has no injectable repository, store or provider token.

Recipe summary schemas and public image projection are compile-time dependencies through `recipes/public.ts`; they do not require a Nest import. No HTTP application provider outside the controller injects `CommunityService`, and worker composition has no community provider. The only external schema consumer is the shared OpenAPI response registry.

Support, AI appeals, admin support and other community-content capabilities remain outside this extraction.

## Decision

`CommunityCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports no business capability;
- owns `CommunityController` and `CommunityService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on the global core database provider without importing `CoreRuntimeModule` again;
- keeps the recipe dependency compile-time only through the recipes public boundary;
- introduces no `forwardRef` or reverse capability dependency.

`community/public.ts` is the explicit named TypeScript boundary. It exposes the composition classes and the two response schemas already consumed by shared OpenAPI.

Worker composition remains independent and must not import or instantiate the community capability.

## Evidence

- Architecture gates reject external deep imports into `community`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Community feed ownership is explicit without bundling adjacent support or moderation domains.
- The recipes relationship remains a compile-time model dependency, not a Nest capability edge.
- No HTTP, OpenAPI, database, authorization, worker or community behavior changes in this checkpoint.
