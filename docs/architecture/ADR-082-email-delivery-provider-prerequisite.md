# ADR-082: Email delivery provider prerequisite

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-081](ADR-081-malware-scanner-provider-prerequisite.md)

## Context

`AppModule` owns the disabled email-delivery implementation and its observable `EMAIL_DELIVERY_PROVIDER` alias. No production service, application-context lookup, readiness path, script or worker injects the token; tests instantiate the disabled class directly.

Web Push has a separate configuration-selected provider chain and must not be moved with this inactive email boundary. The token remains a deliberate fail-closed extension point.

## Decision

`EmailDeliveryProviderCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no capability and owns no controller;
- owns `DisabledEmailDeliveryProvider` and the `EMAIL_DELIVERY_PROVIDER` `useExisting` alias;
- exports only `EMAIL_DELIVERY_PROVIDER`;
- is absent from `WorkerModule`.

Web Push providers/selector and global guards remain root-owned. An explicit `delivery-infrastructure/public.ts` API is the supported external import boundary.

## Evidence

- Static composition regression verifies exact empty imports/controllers, provider pair, alias target and exported token.
- Runtime regression verifies token/class singleton identity and unchanged fail-closed status.
- Negative root and worker ownership regressions prevent duplicate instances.
- Deep-import and exact generated OpenAPI gates protect boundaries.

## Consequences

- Root composition loses exactly the disabled email provider and alias.
- Email delivery remains unavailable until a reviewed provider is introduced.
- Web Push selection and both global guards remain unchanged.
