# ADR-018: Pro access capability and process-scoped worker ownership

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Pro access resolution belongs to the `household-entitlements` bounded context. `ProAccessService` injects the global core database provider and `EntitlementsService`. Seven HTTP application services consume it: pro overview, exports, diary, finance, pricing, nutrition and receipts.

The complete pro-overview feature is not yet a minimal capability because `ProOverviewService` also injects root-owned `AiService`. `DiaryService` depends on pro access and legal consents and is instantiated independently in both HTTP and worker process compositions.

`WorkerModule` is a separate process composition root. It must retain its own `ProAccessService`, backed by the worker-scoped database and entitlements providers; an HTTP singleton cannot and must not be shared across processes.

## Decision

`ProAccessCapabilityModule` is extracted under `src/contexts/household-entitlements/`. It:

- imports exactly `EntitlementsCapabilityModule`;
- owns `ProAccessService` exactly once in HTTP composition;
- exports only `ProAccessService` to the seven current HTTP DI consumers;
- owns no controller and does not absorb `ProOverviewService` or `ProOverviewController`;
- relies on global core database providers without importing `CoreRuntimeModule` again;
- introduces no `forwardRef` or reverse capability dependency.

`pro-overview/public.ts` is the explicit named source boundary for pro access, remaining overview composition, schemas and tests. Source-level visibility does not imply Nest ownership.

`WorkerModule` retains a separate process-scoped `ProAccessService` through the public API and must not import the HTTP capability. Its process-scoped `DiaryService` receives that worker-owned instance.

Extracting diary, receipts or the complete pro-overview feature is outside this checkpoint.

## Evidence

- Architecture gates reject external deep imports into `pro-overview`.
- Static composition regression verifies exact import/provider/export metadata, no root duplicate and worker isolation.
- HTTP runtime regression verifies all seven consumers receive the same capability-owned singleton.
- Worker runtime regression verifies worker diary receives the separate worker-owned pro-access instance.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Pro access can be imported by later receipts and diary capabilities without mixed ownership.
- HTTP and worker instances remain intentionally process-local.
- Complete pro overview remains staged behind its AI prerequisite.
- No HTTP, OpenAPI, database, entitlement or pro-access behavior changes in this checkpoint.
