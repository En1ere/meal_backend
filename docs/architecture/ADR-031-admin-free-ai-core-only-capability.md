# ADR-031: Core-only admin free-AI capability

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-004](ADR-004-acyclic-capability-module-migration.md)

## Context

Administrative inspection and bounded grants for free AI usage belong to the `integrations` bounded context. `AdminFreeAiController` consumes `AdminFreeAiService`; the service injects only global core `DatabaseService` and `AdminAccessService`, while the controller uses the global admin-session guard.

The service reads and writes AI bucket, ledger and operation tables directly inside existing transactional and idempotent workflows. It does not inject `AiService`, an AI provider, provider observer, telemetry or worker runtime. Its view contract reuses `aiBucketSchema` as a compile-time schema dependency only.

No HTTP application provider outside the controller injects `AdminFreeAiService`, and worker composition has no admin-free-AI provider. Shared OpenAPI and one focused contract test consume the existing response/input schemas.

## Decision

`AdminFreeAiCapabilityModule` is extracted under `src/contexts/integrations/`. It:

- imports no business or provider capability;
- owns `AdminFreeAiController` and `AdminFreeAiService` exactly once;
- exports no provider because there is no current HTTP DI consumer outside the capability;
- relies on global core database, admin-access and admin-session-guard providers without importing `CoreRuntimeModule` again;
- keeps the AI schema dependency compile-time only and does not pull in the main AI/provider cluster;
- introduces no `forwardRef` or reverse capability dependency.

`admin-free-ai/public.ts` is the explicit named TypeScript boundary. It exposes composition classes and only schemas already consumed outside the module.

Worker composition remains independent and must not import or instantiate the capability.

## Evidence

- Architecture gates reject external deep imports into `admin-free-ai`.
- Static composition regression verifies exact empty imports/exports, controller/provider ownership, no root duplicates and worker isolation.
- Runtime composition regression verifies the controller receives the capability-owned singleton service, the service receives global database/admin-access singletons and the controller retains `AdminSessionGuard`.
- Exact generated OpenAPI regression protects wire compatibility.

## Consequences

- Administrative AI quota ownership is explicit without merging the main AI, provider-runtime or observability clusters.
- Existing critical-access, transaction, audit and idempotency semantics remain unchanged.
- No HTTP, OpenAPI, database, authorization, worker or AI-provider behavior changes in this checkpoint.
