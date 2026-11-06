# ADR-064: Payment provider prerequisite capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

The remaining payment root cluster contains three independent provider boundaries feeding `PaymentApplicationService`: payment provider, refund provider and repository. The smallest real prerequisite is the fail-closed `DisabledPaymentProvider` plus its `PAYMENT_PROVIDER` alias. The application service is its only DI consumer.

The equally small disabled email alias has no HTTP DI consumer today. Media and account-mail selections use larger configuration factories. `WorkerModule` owns none of these payment providers. Extracting the payment boundary first preserves a real consumer relationship without combining refund, persistence, application or admin-billing responsibilities.

## Decision

`PaymentProviderCapabilityModule` is extracted under `src/contexts/inventory-commerce/`. It:

- imports no capability and owns no controller;
- owns `DisabledPaymentProvider` and the `PAYMENT_PROVIDER` `useExisting` alias exactly once;
- exports only `PAYMENT_PROVIDER`, the token required by root-owned `PaymentApplicationService`;
- keeps the implementation class private to Nest consumers;
- is not imported by `WorkerModule`.

`payments/public.ts` explicitly names the existing payment, refund, application and repository contracts needed by source and tests. External consumers use this boundary and architecture checks prohibit new deep imports.

## Evidence

- Static composition regression verifies exact empty imports/controllers, implementation-plus-alias ownership, token-only export and root-negative ownership.
- Runtime regression verifies the exported token resolves to the same disabled adapter injected into `PaymentApplicationService`.
- Worker isolation regression verifies no payment provider capability, implementation or token in `WorkerModule`.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Payment provider selection becomes an explicit acyclic prerequisite for later payment application extraction.
- Refund, repository, application and admin-billing composition remain unchanged.
- Provider fail-closed behavior, HTTP/OpenAPI, database and worker topology remain unchanged.
