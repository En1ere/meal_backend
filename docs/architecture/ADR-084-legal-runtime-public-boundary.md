# ADR-084: Legal runtime public boundary

- Status: accepted
- Date: 2026-11-04
- Scope: process/library boundary closure
- Depends on: [ADR-003](ADR-003-bounded-context-ownership-map.md)

## Context

`legal-runtime` is an offline release-planning library rather than a Nest capability. Its readiness script and focused test imported the implementation file directly, leaving one of the four remaining domain-module directories outside the enforced public-boundary rule.

## Decision

Add an explicit named `legal-runtime/public.ts` API containing only the five contracts used by the current external consumers. Migrate the offline readiness script and legal-release test to that API and include `legal-runtime` in the architecture deep-import gate.

No Nest provider, controller, runtime path, database contract or legal decision changes.

## Evidence

- Architecture gate rejects future external deep imports into `legal-runtime`.
- Focused legal-release tests preserve evidence validation, readiness and fail-closed behavior.
- Full suite and generated-schema checks protect unrelated runtime contracts.

## Consequences

- Legal release planning retains a narrow, reviewable library boundary.
- Internal schemas and helpers remain private until an evidenced external consumer requires them.
