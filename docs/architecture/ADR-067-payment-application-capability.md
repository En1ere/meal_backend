# ADR-067: Payment application capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-064](ADR-064-payment-provider-prerequisite.md), [ADR-065](ADR-065-refund-provider-prerequisite.md), [ADR-066](ADR-066-payment-repository-prerequisite.md)

## Context

`PaymentApplicationService` coordinates the three already extracted payment boundaries through exactly `PAYMENT_PROVIDER`, `REFUND_PROVIDER` and `PAYMENT_REPOSITORY`. It has no controller, global-core dependency, optional dependency or background lifecycle. `AdminBillingService` is its only production DI consumer, and `WorkerModule` has no payment application provider.

Keeping the application service in root composition after its three prerequisites had explicit ownership left the payment workflow boundary incomplete and exposed implementation details as direct `AppModule` imports.

## Decision

`PaymentApplicationCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports exactly `PaymentProviderCapabilityModule`, `RefundProviderCapabilityModule` and `PaymentRepositoryCapabilityModule`;
- owns and exports `PaymentApplicationService` as the one service required by root-owned `AdminBillingService`;
- owns no controller and introduces no additional provider or token;
- is the only payment capability imported directly by HTTP `AppModule`; its three prerequisites are nested implementation dependencies;
- is not imported by `WorkerModule`.

The existing named `payments/public.ts` remains the compile-time boundary. Payment transaction, idempotency, reconciliation and fail-closed provider behavior are unchanged.

## Evidence

- Static composition regression verifies exact imports, empty controllers, single-provider ownership, minimal export and absence of root duplicates.
- Runtime regression verifies all three injected tokens retain their implementation identities and root-owned `AdminBillingService` receives the same capability-owned application singleton.
- Worker isolation regression verifies no payment application module or service enters `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- The payment provider, refund provider and repository are no longer direct root imports.
- Admin billing remains a separate root-owned capability candidate and depends only on the exported payment application façade.
- HTTP/OpenAPI, database, transaction, authorization and worker behavior remain unchanged.
