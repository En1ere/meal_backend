# ADR-072: Account service prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-070](ADR-070-registration-risk-prerequisite.md), [ADR-071](ADR-071-account-mail-outbox-prerequisite.md)

## Context

`AccountService` is shared by two root-owned HTTP boundaries: `AccountController` implements the authentication and account-security commands, while `MailboxController` exposes the development-only mailbox. A scheduled script also resolves the service from the application context to process due email changes.

The service injects global `DatabaseService`, `AuthService` and `APP_CONFIG`, plus three optional dependencies whose ownership is already explicit: `RegistrationRiskPolicy`, `LegalConsentService` and `ACCOUNT_MAIL_OUTBOX`. It has no worker-process consumer. Moving either controller together with the service would combine separate HTTP boundaries and is unnecessary for establishing provider ownership.

## Decision

`AccountServiceCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports exactly `RegistrationRiskCapabilityModule`, `LegalConsentsCapabilityModule` and `AccountMailOutboxCapabilityModule`;
- relies on global core for database, authentication and configuration;
- owns and exports only `AccountService`;
- owns no controller and is not imported by `WorkerModule`.

`AccountController` and `MailboxController` remain root-owned and consume the exported singleton. Root global `AdminNetworkGuard` and `CsrfGuard` bindings remain unchanged. The unused email and Web Push delivery aliases are outside this checkpoint.

## Evidence

- Static composition regression verifies exact imports/providers/exports, root-negative provider ownership and continued root controller ownership.
- Runtime regression verifies both controllers and application-context lookup share one `AccountService` instance.
- Runtime dependency assertions verify the same global database, authentication and configuration providers and the same three capability-owned dependencies.
- Worker isolation and exact generated OpenAPI regressions protect process and HTTP boundaries.

## Consequences

- Root composition loses one provider without moving or merging HTTP boundaries.
- Scheduled application-context lookup remains available through the exported service.
- Account transactions, authentication, legal checks, registration risk and durable mail behavior are unchanged.
- Account controllers can be migrated separately after their remaining boundary dependencies are analyzed.
