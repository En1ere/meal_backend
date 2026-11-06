# ADR-042: Exports capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-018](ADR-018-pro-access-capability.md), [ADR-041](ADR-041-critical-reauth-capability.md)

## Context

After critical reauthentication received an exported owner, Exports became an acyclic frontier. `ExportsService` injects global `DatabaseService`, `CriticalReauthService` and `ProAccessService`; `ExportsController` injects the service and uses global `UserSessionGuard`.

There is no Legal Consent, storage adapter, repository or provider-token injection. Export manifests, queue state and generated fail-closed payloads are persisted through `DatabaseService`. `WorkerModule` does not register Exports. The operational `process-exports` entry point creates the complete HTTP application context and resolves `ExportsService` with Nest's non-strict `app.get`, so it does not require a module export or a second process-specific provider.

## Decision

`ExportsCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports exactly `CriticalReauthCapabilityModule` and `ProAccessCapabilityModule`;
- owns `ExportsController` and `ExportsService` exactly once;
- exports nothing because no external HTTP provider injects the service;
- relies on global core for database and session guard providers;
- does not invent storage, repository or worker tokens;
- introduces no `forwardRef` or WorkerModule registration.

`exports/public.ts` is the explicit named TypeScript boundary for the controller, service, contracts and pure export policy. External source, script and test consumers use this boundary; architecture gates prohibit deep imports.

## Evidence

- Static composition regression verifies exact imports, controller, provider, empty exports, guard and root-negative ownership.
- Runtime composition regression verifies controller/service, critical-reauth and Pro Access singleton identity, including successful root-context `app.get` lookup.
- Worker isolation regression verifies no capability import or service provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Exports ownership is explicit and uses the prerequisite capabilities without broadening them.
- The process entry point retains one application-context-owned service instance.
- HTTP, OpenAPI, database, authorization, background job and fail-closed storage behavior remain unchanged.
