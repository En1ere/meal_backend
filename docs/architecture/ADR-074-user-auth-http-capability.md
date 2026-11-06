# ADR-074: User authentication HTTP capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The remaining root authentication controllers serve different principals. `AuthController` is the ordinary user boundary; it injects only global `AuthService` and `AuthCookies`. Its `me` handler uses the global `UserSessionGuard`. It has no dependency on account registration, legal consent, registration risk or account-mail capabilities.

`StaffAuthController` remains a separate staff boundary and is not part of this checkpoint. Root `APP_GUARD` bindings continue to enforce network and CSRF policy. Media storage and generic delivery providers are unrelated and also remain root-owned.

## Decision

`UserAuthHttpCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no capability and relies on global core;
- owns only `AuthController`;
- declares no providers and exports nothing;
- is absent from `WorkerModule`.

A minimal explicit `modules/auth/public.ts` exports `AuthController` for this new boundary. Broader auth public-API migration is deliberately deferred because it spans many existing context consumers and is not required for this controller extraction.

## Evidence

- Static composition regression verifies exact empty imports/providers/exports, controller ownership and absence of a root duplicate.
- Guard regression verifies `AuthController.me` retains `UserSessionGuard`.
- Runtime regression verifies the controller receives the global `AuthService` and `AuthCookies` singletons.
- Root regressions keep `StaffAuthController` and `MediaStorageController` in place.
- Worker isolation and exact generated OpenAPI protect process and route boundaries.

## Consequences

- Root composition loses one controller without merging user and staff authentication.
- User routes, guards, cookies, CSRF behavior and OpenAPI remain unchanged.
- Staff authentication, media storage, global guards and delivery aliases remain available for independent checkpoints.
