# ADR-035: Provider-observation capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-011](ADR-011-telemetry-http-capability.md), [ADR-034](ADR-034-secret-provider-capability.md)

## Context

After the secret-provider split, `ProviderObserver` was the only provider-runtime class still owned directly by HTTP `AppModule`. Its constructor injects only `PROVIDER_TELEMETRY`, whose HTTP implementation and alias are owned and exported by `TelemetryCapabilityModule`.

No other HTTP provider injects `ProviderObserver`. Worker composition neither registers the observer nor imports the HTTP telemetry capability. Telemetry has no reverse dependency on the observation capability, so the dependency direction is acyclic.

## Decision

`ProviderObservationCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports exactly `TelemetryCapabilityModule`;
- owns `ProviderObserver` exactly once;
- declares no controller;
- exports nothing because there is no external DI consumer;
- does not import or merge `SecretProviderCapabilityModule`;
- introduces no `forwardRef`, worker registration or reverse telemetry dependency.

The existing explicit `provider-runtime/public.ts` remains the single TypeScript boundary for provider observation contracts and implementation. External deep imports remain prohibited by the architecture gate.

## Evidence

- Static composition regression verifies exact imports, providers, controllers and exports, plus root-negative ownership.
- Runtime composition regression verifies the capability-owned observer receives the same `AdminProviderTelemetry` singleton exposed through `PROVIDER_TELEMETRY`.
- Worker isolation regression verifies no observation capability import or observer provider in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Provider observation has an explicit acyclic composition owner.
- Secret-provider ownership remains independent and unchanged.
- The observer stays private until a real DI consumer requires a reviewed export.
- HTTP, OpenAPI, database, provider-observation and worker behavior remain unchanged.
