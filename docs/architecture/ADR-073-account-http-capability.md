# ADR-073: Account HTTP capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-072](ADR-072-account-service-prerequisite.md)

## Context

After extracting `AccountService`, the remaining account HTTP surface consists of two controllers with the same application-service boundary. `AccountController` injects `AccountService` and global `AuthCookies`; `MailboxController` injects only `AccountService`. Neither controller declares a local guard or owns a provider. Existing root `APP_GUARD` bindings continue to enforce network and CSRF policy for the application.

The authentication and staff-authentication controllers have separate dependencies and remain root-owned. Generic email and Web Push delivery aliases are unrelated to account HTTP composition and also remain root-owned.

## Decision

`AccountHttpCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports exactly `AccountServiceCapabilityModule`;
- owns `AccountController` and `MailboxController`;
- relies on global core for `AuthCookies`;
- declares no providers and exports nothing;
- is not imported by `WorkerModule`.

The route classes, decorators, request validation, cookie behavior and global guard bindings are unchanged.

## Evidence

- Static composition regression verifies exact module metadata and absence of root duplicate controllers.
- Runtime regression verifies both controllers receive the capability-owned `AccountService` singleton and `AccountController` receives the global `AuthCookies` singleton.
- Worker isolation verifies the HTTP capability and controllers are absent from the worker process.
- Exact generated OpenAPI regression protects every route and schema.

## Consequences

- Root composition loses two controllers while account HTTP remains one cohesive boundary.
- Authentication controllers, global guards and unused delivery aliases remain available for independent analysis.
- HTTP/OpenAPI, authentication, cookies, database transactions and account behavior are unchanged.
