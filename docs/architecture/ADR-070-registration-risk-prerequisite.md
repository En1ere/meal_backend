# ADR-070: Registration risk prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

After the payment and news extractions, root composition retained five controllers and twenty-two providers across media storage and account/auth/delivery clusters. Several small aliases are not injected by any current HTTP provider: the generic media-infrastructure tokens and email/Web Push delivery tokens. Selecting one of those only because it has fewer declarations would create ownership without moving a real dependency frontier.

`RegistrationRiskPolicy` is the smallest actually used prerequisite. `AccountService` is its sole DI consumer. The policy is created from `APP_CONFIG` with a null external provider and therefore retains the current disabled/fail-closed behavior. It has no controller, background lifecycle, worker use or peer capability dependency.

## Decision

`RegistrationRiskCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no capability and owns no controller;
- owns the `RegistrationRiskPolicy` factory, injecting global `APP_CONFIG` and applying the existing `registrationRiskConfig` projection;
- exports only `RegistrationRiskPolicy` to root-owned `AccountService`;
- retains the null external provider exactly;
- is not imported by `WorkerModule`.

External compile-time consumers use the explicit named `account/public.ts` API. The still-root-owned account mail, delivery, media and account HTTP providers are deliberately outside this checkpoint.

## Evidence

- Static composition regression verifies exact empty imports/controllers, the single factory token, minimal export and root-negative ownership.
- Runtime regression verifies the policy is the singleton injected into `AccountService`, its derived configuration matches `APP_CONFIG`, and the external provider remains null.
- Worker isolation and exact generated OpenAPI regressions protect process and HTTP boundaries.
- The architecture gate rejects new external deep imports into `account`.

## Consequences

- Root composition loses one real prerequisite provider without claiming unused aliases.
- Registration-risk behavior and provider-failure policy remain unchanged.
- Account mail, AccountService/controllers, authentication, delivery and media clusters remain available for separate checkpoints.
- HTTP/OpenAPI, database, transaction, authorization and worker behavior remain unchanged.
