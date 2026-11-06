# ADR-011: HTTP telemetry capability versus process-scoped library contracts

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The HTTP application previously owned telemetry controller, repository, service and two runtime adapters directly in `AppModule`. `ProviderObserver`, the HTTP exception filter/startup path and `WorkerRuntimeFactory` consume the provider token, telemetry service and worker sink respectively.

`WorkerModule` is a separate process composition root. It intentionally creates its own database, telemetry repository/service and worker sink instances. Importing an HTTP capability there would merge process scopes and alter worker lifecycle semantics.

Telemetry source files also provide library contracts used by HTTP, worker and tests. TypeScript visibility and Nest provider export are distinct concerns.

## Decision

`TelemetryCapabilityModule` is extracted under `src/contexts/platform-operations/` for the HTTP application. It:

- owns `TelemetryController`, `TelemetryRepository`, `TelemetryService`, `AdminProviderTelemetry` and `AdminWorkerRuntimeSink` exactly once;
- owns the `PROVIDER_TELEMETRY -> AdminProviderTelemetry` alias binding;
- imports no business capability and relies on global core database/config providers;
- exports only `TelemetryService`, `AdminWorkerRuntimeSink` and `PROVIDER_TELEMETRY`, matching real HTTP-root consumers;
- keeps the repository, controller and concrete provider adapter private to Nest composition.

`telemetry/public.ts` is the explicit TypeScript library boundary. It names contracts and classes required by source, infrastructure, tests and the separate worker composition. A TypeScript export does not imply a Nest export.

`WorkerModule` continues to declare its own process-scoped telemetry providers through the public API and must not import `TelemetryCapabilityModule`.

Creating `OperationalRuntimeCapabilityModule` or extracting cooking/AI remains outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `telemetry`.
- Static composition regression verifies exact HTTP providers/exports, no root duplicates, no unnecessary imports, and the unchanged separate worker provider scope.
- Runtime regression verifies the provider token alias, controller/sink/service identity, current `WorkerRuntimeFactory` injection and `ProviderObserver` injection.
- HTTP app creation resolves telemetry for the global exception filter; exact generated OpenAPI comparison protects wire compatibility.

## Consequences

- HTTP telemetry has explicit ownership and minimal DI exports.
- Worker telemetry remains isolated per process while sharing the same source-level public contracts.
- The operational-runtime capability can now depend on the exported worker sink without reaching into root-scoped providers.
- No HTTP, OpenAPI, database or telemetry behavior changes in this checkpoint.
