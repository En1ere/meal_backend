# ADR-086: Account mail public boundary

- Status: accepted
- Date: 2026-11-04
- Scope: standalone worker/library boundary closure
- Depends on: [ADR-003](ADR-003-bounded-context-ownership-map.md)

## Context

The standalone account-mail worker, local SMTP smoke script and focused worker test imported configuration, processor and SMTP implementation files directly. This left the `account-mail` process library outside the architecture public-boundary rule despite its deliberate separation from the HTTP Nest composition.

The focused test also reads the processor source file as text to assert transaction and delivery-boundary structure. That path is inspection evidence rather than a TypeScript or runtime import.

## Decision

Add an explicit named `account-mail/public.ts` API containing only the processor, worker configuration reader and type, SMTP provider and template renderer used by current external consumers. Migrate every external runtime and type import to that API and include `account-mail` in the architecture deep-import gate.

Retain the processor source-text path in the focused structural assertion. No Nest module, provider ownership, worker configuration, processor API, SMTP behavior, HTTP/OpenAPI contract or database behavior changes.

## Evidence

- Architecture checks reject future external deep imports into `account-mail`.
- Focused account-mail tests preserve template safety, SMTP outcome classification and worker deployment invariants.
- The full suite and generated-schema check protect unrelated runtime contracts.

## Consequences

- Standalone account-mail composition remains process-scoped and independent from HTTP Nest modules.
- Source-text inspection is explicitly distinguished from a supported runtime import.
- Other implementation details remain private until an evidenced external consumer requires a named export.
