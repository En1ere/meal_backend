# ADR-083: Web Push delivery provider capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-082](ADR-082-email-delivery-provider-prerequisite.md)

## Context

The remaining non-guard root providers form one Web Push chain: `DisabledWebPushDeliveryProvider`, `VapidWebPushProvider` and the `WEB_PUSH_DELIVERY_PROVIDER` selector. Nest builds the VAPID adapter from global `APP_CONFIG`; the selector returns it only when `WEB_PUSH_ENABLED`, otherwise the disabled provider remains active.

No HTTP provider or readiness path currently injects the token. The standalone Web Push worker deliberately constructs `VapidWebPushProvider` from its process-scoped environment and must not import the HTTP capability module.

## Decision

`WebPushDeliveryProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no capability and owns no controller;
- owns the disabled adapter, APP_CONFIG-injected VAPID adapter and exact existing selector;
- exports only `WEB_PUSH_DELIVERY_PROVIDER`;
- is absent from `WorkerModule`.

The email-delivery capability and both global guards remain unchanged.

## Evidence

- Static composition regression verifies exact imports/controllers/providers/exports and selector injection order.
- Selector regression verifies disabled and enabled identity without provider calls.
- Runtime regression verifies global config injection and disabled fail-closed selection.
- Negative root/worker ownership and exact OpenAPI regressions protect boundaries.

## Consequences

- Root composition retains only the two global guard enhancers.
- Web Push configuration, selection and failure behavior remain unchanged.
- The standalone worker retains its separate process-scoped construction path.
