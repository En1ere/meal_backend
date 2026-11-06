# ADR-037: Family-chat capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

HTTP `AppModule` directly owned `FamilyChatController` and `FamilyChatService`. The service injects global `DatabaseService` and `EntitlementsService`; the controller injects only the service and uses global `UserSessionGuard`.

Family membership, thread, message, reaction, mention, pin, draft and read-state operations use direct Kysely queries plus shared workflow helpers. The module does not inject `FamilyService`, media or storage services, delivery providers or provider tokens. It has no attachment pipeline, long-poll, SSE or WebSocket runtime. No production provider injects `FamilyChatService`, and worker composition does not own it.

## Decision

`FamilyChatCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns `FamilyChatController` and `FamilyChatService` exactly once;
- exports nothing because there is no external production DI consumer;
- relies on global core for database and session guard providers;
- does not import or merge Family, Family Notes, media or storage capabilities;
- introduces no `forwardRef`, worker registration or reverse dependency.

`family-chat/public.ts` is the explicit named TypeScript boundary for its controller, service and schemas. External source and test consumers use this boundary; architecture gates prohibit deep imports.

## Evidence

- Static composition regression verifies exact imports, controllers, providers, exports, guard and root-negative ownership.
- Runtime composition regression verifies controller/service identity and the existing entitlement singleton.
- Worker isolation regression verifies no capability import or family-chat service provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Family-chat ownership and entitlement dependency direction are explicit and acyclic.
- Family, Family Notes and media remain independent future frontiers.
- HTTP, OpenAPI, database, authorization, workflow and worker behavior remain unchanged.
