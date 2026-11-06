# ADR-066: Payment repository prerequisite capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-064](ADR-064-payment-provider-prerequisite.md), [ADR-065](ADR-065-refund-provider-prerequisite.md)

## Context

After extracting payment and refund provider boundaries, HTTP `AppModule` still directly owned `PostgresPaymentRepository` and its `PAYMENT_REPOSITORY` alias. The repository injects only global `DatabaseService`; root-owned `PaymentApplicationService` is its only DI consumer. It has no controller, optional dependency or background lifecycle, and `WorkerModule` owns no payment repository.

Payment application and admin billing remain separate responsibilities and do not need to move with this prerequisite.

## Decision

`PaymentRepositoryCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports no capability and owns no controller;
- owns `PostgresPaymentRepository` and the `PAYMENT_REPOSITORY` `useExisting` alias exactly once;
- exports only `PAYMENT_REPOSITORY`, the token required by `PaymentApplicationService`;
- relies on global core for `DatabaseService` and keeps the implementation class private to Nest consumers;
- is not imported by `WorkerModule`.

The existing explicit `payments/public.ts` remains the compile-time boundary.

## Evidence

- Static composition regression verifies exact empty imports/controllers, implementation-plus-alias ownership, token-only export and root-negative ownership.
- Runtime regression verifies the exported token resolves to the same PostgreSQL repository injected into `PaymentApplicationService` and that it shares the global database singleton.
- Worker isolation regression verifies no repository capability, implementation or token in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- All three prerequisites for later payment application extraction now have explicit acyclic ownership.
- Payment application and admin-billing composition remain unchanged.
- Transaction, HTTP/OpenAPI, database and worker behavior remain unchanged.
