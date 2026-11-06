# ADR-029: Core-only admin actions capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The bounded administrative command surface belongs to the `platform-operations` context. `AdminActionsController` consumes `AdminActionsService`; the service injects only the global core database provider, while the controller uses the global admin-session guard.

Authorization, actor locking, audit-event writes and idempotency-record handling are private Kysely workflow inside the service. There is no injectable audit adapter, repository, store, provider token or provider alias. The capability does not inject admin notifications, observability or rollback services. No production HTTP provider outside the controller consumes `AdminActionsService`, and worker composition has no admin-actions provider.

Shared OpenAPI and focused tests consume a bounded set of command/result schemas. Tests also construct the service and consume the pure support-status transition helper.

## Decision

`AdminActionsCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business capability;
- owns `AdminActionsController` and `AdminActionsService` exactly once;
- exports no provider because there is no production HTTP DI consumer outside the capability;
- relies on global core database and admin-session-guard providers without importing `CoreRuntimeModule` again;
- keeps audit/idempotency workflow private and does not invent ceremonial provider abstractions;
- introduces no `forwardRef` or reverse capability dependency.

`admin-actions/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only schemas/helpers already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `admin-actions`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned singleton service, the service receives the global database singleton and the controller retains `AdminSessionGuard`.
- Exact generated OpenAPI regression protects command and response wire compatibility.

## Consequences

- Admin command ownership is explicit without merging notifications, observability or rollback.
- Existing transaction, authorization, audit and idempotency semantics remain unchanged.
- No HTTP, OpenAPI, database, authorization, worker or admin-action behavior changes in this checkpoint.
