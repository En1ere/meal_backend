# ADR-087: Media processing public boundary

- Status: accepted
- Date: 2026-11-04
- Scope: standalone worker/library boundary closure
- Depends on: [ADR-003](ADR-003-bounded-context-ownership-map.md)

## Context

The image CDR child, media processor worker, inventory-ingest worker and focused tests imported configuration, repository, storage, processor and CDR implementation files directly. This left the process-scoped `media-processing` library outside the architecture public-boundary rule.

The focused media processor test also reads repository, child-runner, processor and storage source files as text to assert SQL fencing, child-process isolation and storage behavior. Those paths are inspection evidence rather than TypeScript or runtime imports.

## Decision

Add an explicit named `media-processing/public.ts` API containing only the CDR policy/sanitizer, worker configuration reader, processor/repository/storage classes and job type used by current external consumers. Migrate every external runtime and type import to that API and include `media-processing` in the architecture deep-import gate.

Retain the source-text paths used by focused structural assertions. No Nest module, provider ownership, CDR policy, worker configuration, processor API, storage/repository behavior, HTTP/OpenAPI contract or database behavior changes.

## Evidence

- Architecture checks reject future external deep imports into `media-processing`.
- Focused CDR and media processor tests preserve fail-closed image handling, fencing and isolated worker behavior.
- The full suite and generated-schema check protect unrelated runtime contracts.

## Consequences

- Media processing remains a standalone process composition independent from HTTP Nest modules.
- Source-text inspection is explicitly distinguished from supported runtime imports.
- Unused runner errors, ports and internal configuration types remain private.
