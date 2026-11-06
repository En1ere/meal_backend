# ADR-034: Secret-provider capability split from provider runtime

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The `provider-runtime` source module currently contains two distinct runtime ownership slices:

1. A fail-closed secret boundary: `DisabledSecretProvider` and the `SECRET_PROVIDER` alias.
2. Provider-call observation: `ProviderObserver`, which injects the `PROVIDER_TELEMETRY` token exported by `TelemetryCapabilityModule`.

The secret provider has no constructor dependencies, no current HTTP DI consumer and no worker registration. The observer has a real telemetry prerequisite and remains separately registered in root composition. Combining both into one capability would mix unrelated secret and observability ownership.

External compile-time consumers use provider/secret contracts in telemetry, admin observability and focused tests.

## Decision

`SecretProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no business, telemetry or provider capability;
- owns `DisabledSecretProvider` and the `SECRET_PROVIDER` `useExisting` alias exactly once;
- declares no controller;
- exports no provider or token because there is no current DI consumer outside the capability;
- preserves fail-closed disabled-provider behavior and alias identity;
- leaves `ProviderObserver` in root composition for a later telemetry-dependent extraction;
- introduces no `forwardRef` or reverse capability dependency.

`provider-runtime/public.ts` is the explicit named TypeScript boundary for current composition and all existing compile-time consumers. It uses explicit named exports rather than a wildcard.

Worker composition remains independent and must not import or instantiate the secret capability.

## Evidence

- Architecture gates reject external deep imports into `provider-runtime`.
- Static composition regression verifies exact empty imports/controllers/exports, secret provider/token ownership, no root duplicates, retained root observer and worker isolation.
- Runtime composition regression verifies `SECRET_PROVIDER` resolves to the same capability-owned disabled-provider singleton while `ProviderObserver` still receives the telemetry capability token.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Secret ownership is explicit without bundling observer, AI or unrelated provider owners.
- The token remains private until a real DI consumer requires a reviewed export/import direction.
- Provider observation behavior and scope remain unchanged for a later checkpoint.
- No HTTP, OpenAPI, database, authorization, worker, secret or provider-observation behavior changes in this checkpoint.
