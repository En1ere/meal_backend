# ADR-044: Account-lifecycle capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-041](ADR-041-critical-reauth-capability.md)

## Context

HTTP `AppModule` directly owned the user and admin account-lifecycle controllers plus `AccountLifecycleService`. The service injects global `DatabaseService`, `AuthService` and `AdminAccessService`, and the already extracted `CriticalReauthService`. The user controller injects the lifecycle and critical-reauth services; the admin controller injects only the lifecycle service. Their session guards are global core providers.

There are no other HTTP DI consumers of `AccountLifecycleService`. The account-retention process creates the normal HTTP application context and resolves the service with `app.get`; it is not a `WorkerModule` process-scoped provider.

## Decision

`AccountLifecycleCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports exactly `CriticalReauthCapabilityModule`;
- owns both controllers and the lifecycle service exactly once;
- exports nothing because there is no cross-capability DI consumer;
- relies on global core for database, auth, admin access and both session guards;
- does not import or merge account registration, exports, legal consents or other identity capabilities;
- is not imported by `WorkerModule`.

The existing explicit `account-lifecycle/public.ts` remains the TypeScript boundary for schemas, controllers and services. Process scripts and tests continue using it, while architecture checks prohibit external deep imports.

## Evidence

- Static composition regression verifies exact import/controller/provider/export metadata, both guards and root-negative ownership.
- Runtime regression verifies both controllers share one lifecycle service, both lifecycle consumers share the capability-owned critical-reauth singleton, and global database/auth/admin-access identities are unchanged.
- Worker isolation regression verifies no capability import or lifecycle provider in `WorkerModule`.
- The account-retention script continues resolving the service from the application context through the explicit public API.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Account-lifecycle composition is explicit and acyclic without broadening the identity context module.
- Critical reauthentication retains one HTTP singleton shared with Exports.
- HTTP, OpenAPI, database, authorization, retention-process and worker behavior remain unchanged.
