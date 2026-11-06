# ADR-068: Admin Billing capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-067](ADR-067-payment-application-capability.md)

## Context

`AdminBillingController` is guarded by the global `AdminSessionGuard` and injects only `AdminBillingService`. The service injects global `DatabaseService`, global `AdminAccessService` and `PaymentApplicationService`. It does not inject or import the payment provider, refund provider or repository tokens directly. The controller is the service's only production DI consumer, and `WorkerModule` owns neither admin-billing provider.

With the payment application boundary extracted, admin billing is the next complete acyclic capability in `inventory-commerce`.

## Decision

`AdminBillingCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports exactly `PaymentApplicationCapabilityModule`;
- owns `AdminBillingController` and `AdminBillingService` exactly once;
- exports nothing because there is no external DI consumer;
- relies on global core for database, admin access and the admin-session guard;
- is not imported by `WorkerModule`.

All external compile-time consumers use the explicit named `admin-billing/public.ts` API. Payment transaction, reconciliation, authorization and idempotency behavior remain in the existing services unchanged.

## Evidence

- The architecture gate rejects external deep imports into `admin-billing`.
- Static composition regression verifies exact metadata, empty exports, root-negative ownership and the admin-session guard.
- Runtime regression verifies controller/service identity and that the service shares global database/admin-access and capability-owned payment application singletons.
- Worker isolation and exact generated OpenAPI regressions protect process and HTTP boundaries.

## Consequences

- Root composition no longer owns the admin-billing controller/service or imports payment application directly.
- Payment provider/refund/repository tokens remain private behind `PaymentApplicationService`.
- HTTP/OpenAPI, database, transaction, authorization and worker behavior remain unchanged.
