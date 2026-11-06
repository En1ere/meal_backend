# ADR-025: Core-only AI appeals capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The user-facing AI restriction appeal surface belongs to the `community-content` bounded context. `AiAppealsController` consumes `AiAppealsService`; the service injects only the global core database provider, while the controller uses the global user-session guard. There is no injectable repository, store or provider token.

Appeal response contracts compose existing support ticket and message schemas through `support/public.ts`. This is a compile-time contract dependency, not provider injection. No HTTP application provider outside the controller injects `AiAppealsService`, and worker composition has no AI-appeals provider. The only external schema consumer is the shared OpenAPI response registry.

Admin support is a separate, larger workflow and remains in root composition for a later checkpoint.

## Decision

`AiAppealsCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports no business capability, including `SupportCapabilityModule`;
- owns `AiAppealsController` and `AiAppealsService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database and session-guard providers without importing `CoreRuntimeModule` again;
- keeps support schema composition behind the support public TypeScript boundary;
- introduces no `forwardRef` or reverse capability dependency.

`ai-appeals/public.ts` is the explicit named TypeScript boundary. It exposes the composition classes and the two response schemas already consumed by shared OpenAPI.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `ai-appeals`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- AI appeals ownership is explicit without coupling its Nest composition to Support.
- Admin support remains independently extractable and is not merged with user appeals.
- No HTTP, OpenAPI, database, authorization, worker or appeals behavior changes in this checkpoint.
