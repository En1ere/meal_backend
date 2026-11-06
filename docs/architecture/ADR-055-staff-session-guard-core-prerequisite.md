# ADR-055: Shared staff-session guard core prerequisite

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration prerequisite
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

`StaffSessionGuard` is shared by `StaffAuthController.me` and `ModeratorSessionGuard`. It was directly owned by `AppModule`, while its dependencies `AuthService` and `AuthCookies` already belonged to global `CoreRuntimeModule`.

A bounded capability imported by `AppModule` cannot inject a provider owned only by that parent dynamic module. Keeping the guard root-owned therefore blocks later extraction of the moderator capability or encourages duplicate guard instances.

Moderator controller, service and moderator-session guard remain root-owned in this checkpoint. No moderator capability is introduced.

## Decision

Move only `StaffSessionGuard` from `AppModule` to `CoreRuntimeModule` providers and exports. The guard remains a single HTTP-app provider shared by staff authentication and the root-owned moderator guard.

No controller, domain service, contract, worker provider or other authentication guard moves in this checkpoint.

## Evidence

- Static composition regression verifies root-negative ownership and exactly one core provider/export.
- Runtime regression verifies `ModeratorSessionGuard` receives the same `StaffSessionGuard` resolved from the application graph.
- Existing exact OpenAPI and full-suite regressions protect staff authentication and moderator behavior.

## Consequences

- The shared staff authentication prerequisite has correct global visibility without duplication.
- Moderator extraction becomes an independent follow-up checkpoint.
- HTTP, OpenAPI, database, authentication and worker behavior remain unchanged.
