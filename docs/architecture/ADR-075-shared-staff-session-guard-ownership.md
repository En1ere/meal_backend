# ADR-075: Shared staff-session guard ownership

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-055](ADR-055-staff-session-guard-core-prerequisite.md)

## Context

Nest scans guard classes referenced by `@UseGuards` into the controller's owning module as enhancer injectables. Moving `StaffAuthController` out of root composition while keeping `@UseGuards(StaffSessionGuard)` therefore creates a module-local `StaffSessionGuard`. `ModeratorSessionGuard` continues to receive the CoreRuntime-owned guard, so the two staff-authentication boundaries no longer share one guard instance.

The guard is stateless today, but duplicate ownership violates the approved singleton composition rule and makes future guard state or instrumentation unsafe. Moving the controller or changing routes is not required to solve ownership.

## Decision

CoreRuntime remains the sole owner of `StaffSessionGuard` and additionally publishes the explicit `STAFF_SESSION_GUARD` token with `useExisting: StaffSessionGuard`.

`StaffSessionRouteGuard` is a thin route-level enhancer that:

- injects `STAFF_SESSION_GUARD`;
- delegates `canActivate` without changing its result or request principal;
- contains no state or policy of its own.

`StaffAuthController.me` references the wrapper in `@UseGuards`. `ModeratorSessionGuard` injects the same explicit token before applying its existing moderator-context check. The controller and moderator capability remain in their current modules for this checkpoint.

## Evidence

- Core metadata regression verifies one `StaffSessionGuard` provider and one token alias.
- Negative composition regressions verify root and worker do not own the guard, alias or wrapper.
- Runtime regression proves the token resolves to the CoreRuntime guard and both the route wrapper and `ModeratorSessionGuard` delegate to that exact instance.
- Method metadata regression verifies the staff route uses only the delegating wrapper.
- Exact generated OpenAPI regression protects the public HTTP contract.

## Consequences

- Staff and moderator authentication now have explicit, durable shared guard ownership.
- The wrapper may be instantiated by Nest at the route boundary, but it cannot duplicate authentication state or policy.
- Routes, cookies, authentication behavior, moderator authorization and worker composition are unchanged.
- A later checkpoint may move `StaffAuthController` without duplicating `StaffSessionGuard`.
