# ADR-023: Core-only support capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

User support ticket behavior belongs to the `community-content` bounded context. `SupportController` consumes `SupportService`. The service injects only the global core database provider, while the controller uses the global user-session guard.

Support workflow and transaction logic is implemented directly with Kysely inside the service. There is no injectable store, repository or provider token. No helper function is consumed outside the module. No HTTP application service outside the support controller injects `SupportService`, and worker composition has no support provider.

External compile-time consumers are limited to shared OpenAPI response mapping, AI-appeal response composition and a direct service test.

## Decision

`SupportCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports no business capability;
- owns `SupportController` and `SupportService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- keeps workflow implementation inside the service instead of introducing ceremonial repositories or tokens;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- introduces no `forwardRef` or reverse capability dependency.

`support/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only the response schemas already consumed by shared OpenAPI and AI appeals.

Worker composition remains independent and must not import or instantiate the support capability.

## Evidence

- Architecture gates reject external deep imports into `support`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Support ownership is explicit without creating an artificial persistence abstraction.
- Existing AI-appeal contract composition remains compile-time only.
- No HTTP, OpenAPI, database, authorization or support behavior changes in this checkpoint.
