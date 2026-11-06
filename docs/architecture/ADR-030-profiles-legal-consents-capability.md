# ADR-030: Profiles capability with legal-consent prerequisite

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-013](ADR-013-legal-consents-capability.md)

## Context

Own and public profile behavior belongs to the `identity-access` bounded context. `ProfilesController` consumes `ProfilesService`; the service injects the global core database provider and `LegalConsentService`. Own-profile read/update routes use the global user-session guard, while the public author projection remains anonymous.

No HTTP application provider outside the controller injects `ProfilesService`, and worker composition has no profiles provider. Shared OpenAPI consumes own/public profile schemas; a focused test consumes the public schema and pure projection helper.

After checkpoint 28, Profiles is the smallest remaining root-composition frontier at 244 source lines. Its only business prerequisite is the already acyclic `LegalConsentsCapabilityModule`.

## Decision

`ProfilesCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports exactly `LegalConsentsCapabilityModule`;
- owns `ProfilesController` and `ProfilesService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database and user-session-guard providers without importing `CoreRuntimeModule` again;
- preserves anonymous access to the public route and guarded access to own-profile routes;
- introduces no `forwardRef` or reverse capability dependency.

`profiles/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only schemas/helpers already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `profiles`.
- Static composition regression verifies the exact legal-consents import, empty exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned singleton service, the service receives the global database and legal-consent singletons, and guard metadata remains only on own-profile methods.
- Exact generated OpenAPI regression protects authenticated and public wire compatibility.

## Consequences

- Profiles ownership is explicit without broadening identity-access composition.
- Public projection remains compile-time API; the service remains private to the capability.
- No HTTP, OpenAPI, database, authorization, worker or profile behavior changes in this checkpoint.
