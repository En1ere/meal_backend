# ADR-071: Account mail outbox prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-070](ADR-070-registration-risk-prerequisite.md)

## Context

After extracting registration risk, root composition retained the account mail outbox implementations and selector. `AccountService` is the sole HTTP DI consumer of `ACCOUNT_MAIL_OUTBOX`. The disabled and Postgres implementations have no constructor dependencies: the Postgres implementation writes through the transaction supplied by `AccountService`, so it does not own or inject `DatabaseService`. The selector depends only on global `APP_CONFIG` and chooses Postgres when `ACCOUNT_MAIL_ENABLED` is true, otherwise the fail-closed disabled implementation.

The worker process does not consume the token or either implementation. Generic email and Web Push delivery aliases are also not part of this dependency chain and remain root-owned for later analysis.

## Decision

`AccountMailOutboxCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no capability and owns no controller;
- owns `DisabledAccountMailOutbox`, `PostgresAccountMailOutbox` and the existing `ACCOUNT_MAIL_OUTBOX` selector factory;
- relies only on global `APP_CONFIG` for selection;
- exports only `ACCOUNT_MAIL_OUTBOX` to the root-owned `AccountService`;
- is not imported by `WorkerModule`.

`AccountService`, account controllers, email delivery and Web Push delivery remain outside this checkpoint.

## Evidence

- Static composition regression verifies exact imports, controllers, providers and minimal token export.
- Selector regression verifies disabled and enabled configuration identities without changing the factory.
- Runtime regression verifies the selected disabled singleton is injected into `AccountService` and remains fail closed for production readiness.
- Worker isolation and exact generated OpenAPI regressions protect process and HTTP boundaries.
- Existing account public-boundary checks prevent new external deep imports.

## Consequences

- Root composition loses three provider declarations while preserving the same token identity and selection behavior.
- Durable enqueue behavior, transaction ownership and database schema are unchanged.
- Production remains fail closed whenever account mail is disabled or unavailable.
- AccountService/controllers and the remaining media/auth/delivery providers can be migrated independently.
