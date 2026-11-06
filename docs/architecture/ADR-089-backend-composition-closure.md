# ADR-089: Backend composition closure

- Status: accepted
- Date: 2026-11-04
- Scope: composition regression ownership and test structure
- Depends on: [ADR-088](ADR-088-architecture-closure-invariants.md)

## Context

The complete composition regression had grown into one 2,861-line test file containing static Nest metadata checks, standalone WorkerModule assertions and runtime singleton/OpenAPI verification. It protected the accumulated extraction checkpoints, but ownership closure and HTTP/worker separation were difficult to review independently.

## Decision

Split composition coverage into three coherent suites:

- `composition-static.test.ts` owns static capability metadata and root/recursive HTTP graph assertions.
- `composition-worker.test.ts` owns standalone WorkerModule isolation and process-scoped overlap assertions.
- `composition-runtime.test.ts` owns instantiated singleton identity, guard wiring and exact OpenAPI equality.

Preserve every existing assertion while adding exact closure invariants:

- configured `AppModule` has no controllers and exactly two root providers: `APP_GUARD` using `AdminNetworkGuard` and `CsrfGuard`;
- the recursively reachable HTTP graph contains 68 unique controllers and 121 unique provider tokens;
- no controller/provider token has multiple owners except the explicit two-entry root `APP_GUARD` multi-provider;
- all 79 checked-in context module classes are reachable from `AppModule` and no stale context module remains;
- `WorkerModule` imports no HTTP capability module;
- its exact 18-token HTTP overlap is intentional and process-scoped: config, database, auth/admin access, telemetry/runtime, operational governance, entitlements/legal, scheduled news, Pro/diary and cooking lifecycle providers.

The two pre-existing deep imports needed to inspect foundational auth singleton identity are centralized in one test-only fixture, so splitting the suites does not increase the 149-entry auth debt ratchet.

Counts complement, rather than replace, the source-derived uniqueness/reachability comparisons. Any legitimate future capability change must update the implementation and closure evidence together.

## Consequences

- Static ownership, process isolation and runtime behavior can fail and be diagnosed independently.
- The standalone worker cannot silently acquire an HTTP capability graph.
- Provider duplication and stale context modules fail before deployment.
- Production Nest composition, HTTP/OpenAPI contracts and worker behavior are unchanged.
