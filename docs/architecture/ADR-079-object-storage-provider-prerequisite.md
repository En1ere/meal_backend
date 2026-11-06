# ADR-079: Generic object-storage provider prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-078](ADR-078-media-storage-http-capability.md)

## Context

After extracting media HTTP composition, `AppModule` retains thirteen providers: two global guards, six generic media placeholder entries and five delivery entries. The generic media entries are three disabled implementations with three observable `useExisting` aliases.

No production service, readiness path or worker currently injects `OBJECT_STORAGE_PROVIDER`. Tests instantiate the disabled provider directly. The token remains an intentional fail-closed extension boundary and must not be deleted merely because it currently has no consumer.

## Decision

`ObjectStorageProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no capability and owns no controller;
- owns `DisabledObjectStorageProvider` and the `OBJECT_STORAGE_PROVIDER` `useExisting` alias;
- exports only `OBJECT_STORAGE_PROVIDER`;
- is absent from `WorkerModule`.

The KMS, malware-scanner, email, Web Push and global guard entries remain root-owned. An explicit `media-infrastructure/public.ts` API becomes the only supported external import boundary.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider pair, alias target and exported token.
- Runtime regression verifies the token and class resolve to the same disabled singleton and expose the unchanged fail-closed status.
- Negative root and worker ownership regressions prevent duplicate instances.
- Deep-import and exact generated OpenAPI gates protect module and HTTP boundaries.

## Consequences

- Root composition loses exactly one cohesive class/alias pair without deleting the observable token.
- Generic object storage remains disabled and fail-closed until a reviewed implementation is introduced.
- The independent KMS and malware-scanner boundaries remain available for separate checkpoints.
