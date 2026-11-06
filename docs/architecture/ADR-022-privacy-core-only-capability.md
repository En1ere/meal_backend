# ADR-022: Core-only privacy capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Privacy settings behavior belongs to the `identity-access` bounded context. `PrivacyController` consumes `PrivacyService`. The service injects only the global core database provider, while the controller uses the global user-session guard.

No HTTP application service outside the privacy controller injects `PrivacyService`. Worker composition has no privacy provider. The only external source dependency is the privacy response schema used by shared OpenAPI response mapping.

Privacy was selected from the remaining core-only frontier because it has the smallest ownership and dependency surface. Support and community carry broader workflow contracts; AI/admin alternatives belong to more sensitive operational compositions.

## Decision

`PrivacyCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability;
- owns `PrivacyController` and `PrivacyService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database/auth providers without importing `CoreRuntimeModule` again;
- introduces no `forwardRef` or reverse capability dependency.

`privacy/public.ts` is the explicit named TypeScript boundary for composition and the shared response schema.

Worker composition remains independent and must not import or instantiate the privacy capability.

## Evidence

- Architecture gates reject external deep imports into `privacy`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned service and the service receives the global database singleton.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Privacy ownership is explicit without introducing any business-module dependency.
- No HTTP, OpenAPI, database, authorization or privacy behavior changes in this checkpoint.
