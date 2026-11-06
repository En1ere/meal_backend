# ADR-028: Core-only admin notifications capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The administrative notification center belongs to the `platform-operations` bounded context. `NotificationCenterController` consumes `NotificationCenterService`; the service injects only the global core database provider, while the controller uses the global admin-session guard.

Notification reads, settings and audit records are persisted directly through the database. The service does not inject a delivery adapter, outbox provider or provider token, and currently projects `deliveryConnected` as false. Private audit and workflow helpers remain implementation details. No HTTP application provider outside the controller injects the service, and worker composition has no admin-notifications provider.

Shared OpenAPI consumes the center response schema. A contract test consumes the same schema, timezone/quiet-hours helpers and default settings projection.

## Decision

`AdminNotificationsCapabilityModule` is extracted under `src/contexts/platform-operations/`. It:

- imports no business or delivery capability;
- owns `NotificationCenterController` and `NotificationCenterService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database and admin-session-guard providers without importing `CoreRuntimeModule` again;
- keeps database workflow helpers private and does not invent a delivery abstraction;
- introduces no `forwardRef` or reverse capability dependency.

`admin-notifications/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only the schemas/helpers already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `admin-notifications`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned singleton service, the service receives the global database singleton and the controller retains `AdminSessionGuard`.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Administrative notification ownership is explicit without coupling the HTTP capability to delivery infrastructure.
- Existing settings, quiet-hours, transaction, authorization and audit semantics remain unchanged.
- No HTTP, OpenAPI, database, authorization, worker or notification behavior changes in this checkpoint.
