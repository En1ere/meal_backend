# ADR-013: HTTP legal-consents capability and worker isolation

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Legal consent HTTP behavior consists of public/user controllers, a consent service, an optional feature guard and a database-backed document provider behind `LEGAL_DOCUMENT_PROVIDER`. These components depend only on global core database/config/auth providers and Nest reflector infrastructure.

Many HTTP application services consume `LegalConsentService`. The guard, concrete provider and provider token have no consumer outside the legal capability. `WorkerModule` is a separate process composition root and intentionally creates its own legal service/provider instances for scheduled work.

## Decision

`LegalConsentsCapabilityModule` is extracted under `src/contexts/identity-access/`. It:

- imports no business capability;
- owns `PublicLegalController`, `LegalConsentController`, `LegalConsentService`, `LegalConsentGuard` and `DatabaseLegalDocumentProvider` exactly once;
- owns the `LEGAL_DOCUMENT_PROVIDER -> DatabaseLegalDocumentProvider` alias binding;
- exports only `LegalConsentService` for current HTTP application DI consumers;
- keeps the guard, concrete provider and token private;
- relies on global core providers and introduces no `forwardRef`.

`legal-consents/public.ts` is the explicit named TypeScript boundary for contracts, exceptions, decorators and worker composition classes. TypeScript visibility does not imply a Nest export.

`WorkerModule` retains its separate process-scoped legal service/provider/token binding through this public API and must not import the HTTP capability.

Extracting content releases or other service consumers is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `legal-consents`.
- Static composition regression verifies exact controllers/providers/token alias, minimal exports, no root duplicates and unchanged worker isolation.
- Runtime regression verifies provider alias identity and that controllers, guard and all registered HTTP consumers receive the same capability-owned service.
- Worker tests and exact generated OpenAPI protect process and wire compatibility.

## Consequences

- HTTP legal-consent ownership and private provider binding are explicit.
- Worker legal processing remains process-isolated while sharing the same source-level public contracts.
- No HTTP, OpenAPI, database, evidence or consent behavior changes in this checkpoint.
