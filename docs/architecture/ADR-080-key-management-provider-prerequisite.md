# ADR-080: Generic key-management provider prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-079](ADR-079-object-storage-provider-prerequisite.md)

## Context

`AppModule` still owns the generic disabled key-management implementation and its observable `KEY_MANAGEMENT_PROVIDER` alias. No production service, application-context lookup, readiness path, script or worker injects this token. Unit tests instantiate the disabled class directly.

The alias remains an intentional fail-closed extension boundary and must remain available independently from object storage, malware scanning and delivery infrastructure.

## Decision

`KeyManagementProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no capability and owns no controller;
- owns `DisabledKeyManagementProvider` and the `KEY_MANAGEMENT_PROVIDER` `useExisting` alias;
- exports only `KEY_MANAGEMENT_PROVIDER`;
- is absent from `WorkerModule`.

Object storage, malware scanning, delivery infrastructure and global guards remain unchanged.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider pair, alias target and exported token.
- Runtime regression verifies token/class singleton identity and unchanged fail-closed status.
- Negative root and worker ownership regressions prevent duplicate instances.
- Exact generated OpenAPI protects the unaffected HTTP surface.

## Consequences

- Root composition loses exactly the generic key-management class/alias pair.
- The provider remains explicitly unavailable until a reviewed implementation is added.
- Malware scanning and delivery remain separate future composition checkpoints.
