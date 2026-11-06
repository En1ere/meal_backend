# ADR-085: Web Push public boundary

- Status: accepted
- Date: 2026-11-04
- Scope: standalone worker/library boundary closure
- Depends on: [ADR-003](ADR-003-bounded-context-ownership-map.md)

## Context

The standalone Web Push worker and its production-focused test imported the worker configuration and processor implementation files directly. This left the `web-push` library directory outside the architecture public-boundary rule even though its runtime is intentionally separate from the HTTP Nest composition.

## Decision

Add an explicit named `web-push/public.ts` API containing only the worker configuration reader, processor class and quiet-hours projection used by current external consumers. Migrate the standalone worker and production test to that API and include `web-push` in the architecture deep-import gate.

No Nest module, provider ownership, worker configuration, processor API, HTTP/OpenAPI contract or database behavior changes.

## Evidence

- Architecture checks reject future external deep imports into `web-push`.
- Focused production tests preserve configuration, quiet-hours, delivery and worker deployment behavior.
- The full suite and exact generated-schema check protect unrelated runtime contracts.

## Consequences

- Standalone Web Push composition remains process-scoped and independent from HTTP Nest modules.
- Internal processor and configuration implementation details remain private until an evidenced consumer requires another named export.
