# ADR-032: Family notes capability with entitlements prerequisite

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Family note and checklist behavior belongs to the `household-entitlements` bounded context. `FamilyNotesController` consumes `FamilyNotesService`; the service injects the global core database provider and `EntitlementsService`, while the controller uses the global user-session guard.

The service has no injectable repository, store or provider token. Its transaction/idempotency behavior uses existing shared workflow functions and internal Kysely queries. It has no source or DI dependency on the broader Family or Family Chat modules.

No HTTP application provider outside the controller injects `FamilyNotesService`, and worker composition has no family-notes provider. Shared OpenAPI consumes three response schemas; a focused family test consumes two command schemas. A query-optimization regression reads the service source text directly and is not a TypeScript module consumer.

## Decision

`FamilyNotesCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns `FamilyNotesController` and `FamilyNotesService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database and user-session-guard providers without importing `CoreRuntimeModule` again;
- remains separate from Family and Family Chat composition;
- introduces no `forwardRef` or reverse capability dependency.

`family-notes/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only schemas already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `family-notes`.
- Static composition regression verifies the exact entitlements import, empty exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned singleton service, the service receives global database/entitlements singletons and the controller retains `UserSessionGuard`.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Family Notes ownership is explicit without merging adjacent household capabilities.
- Existing entitlement, transaction, workflow and idempotency semantics remain unchanged.
- No HTTP, OpenAPI, database, authorization, worker or family-note behavior changes in this checkpoint.
