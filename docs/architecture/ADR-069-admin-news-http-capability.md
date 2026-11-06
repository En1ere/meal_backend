# ADR-069: Admin News HTTP capability

- Status: accepted
- Date: 2026-11-04
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md), [ADR-013](ADR-013-legal-consents-capability.md)

## Context

The HTTP application directly owned `AdminNewsController`, `NewsPublicController`, `AdminNewsService`, `NewsPublicService` and `ScheduledNewsRunner`. The services and runner inject global database/authentication infrastructure plus `EntitlementsService` and, for administrative delivery, `LegalConsentService`. Delivery is performed only by the internal in-app helper; no email, Web Push or account-mail adapter is injected.

`ScheduledNewsRunner` also exists as a deliberately separate provider in `WorkerModule`. The protected operational-maintenance entry point still creates the HTTP application context and resolves its runner with `app.get`, while the scheduler creates the worker context. Both process scopes must remain valid without importing an HTTP module into the worker.

## Decision

`AdminNewsCapabilityModule` is extracted under `src/contexts/community-content/`. It:

- imports exactly `EntitlementsCapabilityModule` and `LegalConsentsCapabilityModule`;
- owns the two HTTP controllers and all three providers in the HTTP application scope;
- exports nothing because there is no Nest DI consumer outside the capability;
- relies on global core for database, admin access, authentication, cookies and session guards;
- does not import delivery-infrastructure or account modules.

`WorkerModule` continues to own its process-scoped `ScheduledNewsRunner`, entitlements, legal-consent and database dependencies. It imports the class through the explicit named `admin-news/public.ts` compile-time API and does not import `AdminNewsCapabilityModule`.

## Evidence

- The architecture gate rejects external deep imports into `admin-news`.
- Static composition regression verifies exact module metadata, empty exports, root-negative ownership and controller guards.
- Runtime regression verifies controller/service identity, shared global and capability dependencies, and operational `app.get` access to the HTTP runner.
- Worker regression verifies separate runner ownership and absence of HTTP controllers/services/capability imports.
- Exact generated OpenAPI regression protects the unchanged HTTP surface.

## Consequences

- Root composition no longer owns news controllers or providers directly.
- HTTP and worker runner instances retain separate process lifetimes.
- External delivery remains fail-closed and outside this capability until reviewed providers are intentionally introduced.
- HTTP/OpenAPI, database, transaction, authorization and worker behavior remain unchanged.
