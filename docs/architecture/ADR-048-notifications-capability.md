# ADR-048: User-notifications capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned two user-notification controllers plus `NotificationsService` and `WebPushSubscriptionsService`. Both services inject only global `DatabaseService` and `APP_CONFIG`; both controllers use global `UserSessionGuard`.

The services persist notification preferences/read state and encrypted Web Push subscription endpoints. They do not inject Web Push delivery, email delivery, account-mail outbox or provider tokens/adapters. Those delivery/runtime concerns remain separate infrastructure ownership. Admin notification-center behavior is owned by `AdminNotificationsCapabilityModule` and is not part of this boundary.

There are no external HTTP DI consumers, scheduled/process consumers or `WorkerModule` providers.

## Decision

`NotificationsCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no business or delivery capability;
- owns both user controllers and both services exactly once;
- exports nothing because there is no cross-capability DI consumer;
- declares no provider tokens or aliases;
- relies on global core for database, configuration and user-session guard;
- does not merge admin notifications, delivery infrastructure or outbox providers;
- is not imported by `WorkerModule`.

`notifications/public.ts` explicitly names schemas, controllers and services required by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/exports, controllers/services, both guards and root-negative ownership.
- Runtime regression verifies controller-service identity and unchanged global database/config singletons.
- Worker isolation regression verifies no capability or notification service in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- User notification state and subscription ownership are explicit without coupling them to delivery execution.
- Admin notifications and delivery/outbox infrastructure retain independent owners.
- HTTP, OpenAPI, database, encryption, authorization and worker behavior remain unchanged.
