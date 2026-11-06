# ADR-076: Staff authentication HTTP capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-075](ADR-075-shared-staff-session-guard-ownership.md)

## Context

After establishing explicit shared ownership for staff-session authentication, `StaffAuthController` is the remaining root-owned staff HTTP boundary. It injects only global `AuthService` and `AuthCookies`. Its `me` route uses `StaffSessionRouteGuard`, whose only dependency is the CoreRuntime-owned `STAFF_SESSION_GUARD` alias.

The controller owns no provider and has no worker-process consumer. Media storage, root `APP_GUARD` bindings and generic delivery providers are separate concerns.

## Decision

`StaffAuthHttpCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no capability and relies on global core;
- owns only `StaffAuthController`;
- declares no providers and exports nothing;
- is absent from `WorkerModule`.

The explicit auth public API now names `StaffAuthController`. CoreRuntime guard/token ownership and `ModeratorSessionGuard` remain unchanged.

## Evidence

- Static composition regression verifies exact empty imports/providers/exports and absence of a root duplicate.
- Method metadata regression verifies the staff route retains only `StaffSessionRouteGuard`.
- Runtime regression verifies the child-module route wrapper resolves the same token-owned `StaffSessionGuard` used by `ModeratorSessionGuard`.
- Runtime regression also verifies global `AuthService` and `AuthCookies` identities.
- Worker isolation and exact generated OpenAPI protect process and route boundaries.

## Consequences

- Root composition loses the staff-authentication controller without duplicating guard policy or state.
- Staff login, MFA, session, cookie and logout behavior remain unchanged.
- Media storage, global guards and delivery providers remain available for separate checkpoints.
