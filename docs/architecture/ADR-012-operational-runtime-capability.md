# ADR-012: operational runtime library and HTTP DI capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-011](ADR-011-telemetry-http-capability.md)

## Context

Operational runtime contains two distinct concerns:

1. Framework-independent worker topology, scheduler, lease/runtime, readiness, acceptance and recovery contracts consumed by source, infrastructure, scripts and tests.
2. The HTTP application's `WorkerRuntimeFactory`, which composes global database/config with the HTTP telemetry sink and is consumed through DI by AI reconciliation and cooking lifecycle services.

Before telemetry ownership was extracted, moving the factory would have hidden a dependency on a root-scoped sink. ADR-011 now provides an explicit telemetry capability that exports the sink while keeping it privately owned there.

`WorkerModule` is a separate process composition root and must retain its own `WorkerRuntimeFactory` and telemetry providers.

## Decision

`operational-runtime/public.ts` becomes the explicit named TypeScript boundary for all operational contracts and functions. External source, infrastructure, scripts and tests must not deep-import its implementation files.

`OperationalRuntimeCapabilityModule` is extracted under `src/contexts/platform-operations/` for the HTTP application. It:

- imports exactly `TelemetryCapabilityModule`;
- owns and exports exactly `WorkerRuntimeFactory`;
- relies on global database/config providers from `CoreRuntimeModule`;
- does not own or re-provide `AdminWorkerRuntimeSink`;
- introduces no cooking or AI providers and no `forwardRef`.

The HTTP dependency direction is:

`AiReconciliationService / CookingLifecycleService -> OperationalRuntimeCapabilityModule -> TelemetryCapabilityModule -> global core runtime`.

`WorkerModule` continues declaring a separate process-scoped factory and telemetry stack through public TypeScript APIs. It imports neither HTTP capability module.

## Evidence

- Architecture gates reject external deep imports into `operational-runtime`.
- Static composition regression verifies exact capability imports/providers/exports, no root duplicate and telemetry sink ownership remaining in telemetry.
- Runtime regression verifies AI reconciliation and cooking lifecycle receive the same capability-owned factory.
- Worker tests protect the separate process composition; exact generated OpenAPI protects HTTP compatibility.

## Consequences

- Operational library contracts and HTTP DI ownership are explicit and independently enforceable.
- Telemetry ownership remains single and factory wiring no longer depends on root provider leakage.
- No worker, HTTP, OpenAPI, database or scheduling behavior changes in this checkpoint.
