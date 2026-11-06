# ADR-033: OCR provider capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The OCR provider boundary belongs to the `integrations` bounded context. Current HTTP application composition registers `DisabledOcrProvider` and aliases `OCR_PROVIDER` to the same instance. The provider has no injected dependencies and no controller.

There is currently no HTTP or worker DI consumer for the OCR token; preserving the registration keeps the fail-closed provider boundary available without broadening another capability. Media checksum and object-key schemas are compile-time contract dependencies only.

At 209 source lines and two root provider entries, OCR infrastructure is the smallest remaining AppModule frontier after checkpoint 31. The adjacent provider-runtime frontier has observer/secret consumers and is therefore broader.

## Decision

`OcrCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no business or media capability;
- owns `DisabledOcrProvider` and the `OCR_PROVIDER` `useExisting` alias exactly once;
- declares no controller;
- exports no provider or token because there is no current DI consumer outside the capability;
- preserves fail-closed disabled-provider behavior and alias identity;
- introduces no `forwardRef` or reverse capability dependency.

`ocr-infrastructure/public.ts` is the explicit named TypeScript boundary. It exposes the provider/token required for composition and only contracts/helpers already consumed by focused tests.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `ocr-infrastructure`.
- Static composition regression verifies exact empty imports/controllers/exports, provider/token ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies `OCR_PROVIDER` resolves to the same capability-owned disabled-provider singleton.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- OCR provider ownership is explicit without pulling in media, main AI or provider-runtime clusters.
- The token remains private until a real DI consumer requires a reviewed export/import direction.
- No HTTP, OpenAPI, database, authorization, worker or OCR behavior changes in this checkpoint.
