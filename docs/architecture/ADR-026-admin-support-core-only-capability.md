# ADR-026: Core-only admin support capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The administrative support workspace belongs to the `community-content` bounded context. `AdminSupportController` consumes `AdminSupportService`; the service injects only the global core database provider, while the controller uses the global admin-session guard. Transaction, idempotency and workflow helpers are private service implementation details. There is no injectable repository, store, provider token or provider alias.

No HTTP application provider outside the controller injects `AdminSupportService`, and worker composition has no admin-support provider. Shared OpenAPI consumes the workspace and managed-result schemas; one contract test consumes the manage-input schema. The implementation has no compile-time dependency on the user Support module, so no artificial Support edge is introduced. AI Appeals remains a separate capability.

## Decision

`AdminSupportCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports no business capability;
- owns `AdminSupportController` and `AdminSupportService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database and admin-session-guard providers without importing `CoreRuntimeModule` again;
- keeps workflow helpers private rather than introducing ceremonial providers;
- introduces no `forwardRef` or reverse capability dependency.

`admin-support/public.ts` is the explicit named TypeScript boundary. It exposes the composition classes and only the three schemas already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `admin-support`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton; the controller continues to declare `AdminSessionGuard`.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Administrative support ownership is explicit without merging it with user Support or AI Appeals.
- Existing transaction, authorization and idempotency semantics remain inside the service.
- No HTTP, OpenAPI, database, authorization, worker or support behavior changes in this checkpoint.
