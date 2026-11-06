# ADR-065: Refund provider prerequisite capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-064](ADR-064-payment-provider-prerequisite.md)

## Context

After extracting the payment provider boundary, HTTP `AppModule` still directly owned `DisabledRefundProvider` and its `REFUND_PROVIDER` alias. Root-owned `PaymentApplicationService` is the only DI consumer. The provider has no configuration, controller, optional dependency or background lifecycle, and `WorkerModule` owns no refund providers.

Repository, payment application and admin billing remain separate responsibilities and do not need to move with this prerequisite.

## Decision

`RefundProviderCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports no capability and owns no controller;
- owns `DisabledRefundProvider` and the `REFUND_PROVIDER` `useExisting` alias exactly once;
- exports only `REFUND_PROVIDER`, the token required by `PaymentApplicationService`;
- keeps the implementation class private to Nest consumers;
- is not imported by `WorkerModule`.

The existing explicit `payments/public.ts` remains the compile-time boundary.

## Evidence

- Static composition regression verifies exact empty imports/controllers, implementation-plus-alias ownership, token-only export and root-negative ownership.
- Runtime regression verifies the exported token resolves to the same disabled adapter injected into `PaymentApplicationService`.
- Worker isolation regression verifies no refund provider capability, implementation or token in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Payment and refund provider selection are independent acyclic prerequisites for later payment application extraction.
- Repository, application and admin-billing composition remain unchanged.
- Fail-closed refund behavior, HTTP/OpenAPI, database and worker topology remain unchanged.
