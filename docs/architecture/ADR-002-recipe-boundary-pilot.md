# ADR-002: recipe policy and lifecycle boundary pilot

- Status: accepted
- Date: 2026-11-03
- Scope: `src/modules/recipe-policy`, `src/modules/recipe-lifecycle`
- Depends on: [ADR-001](ADR-001-backend-bounded-context-baseline.md)

## Context

ADR-001 froze the current module graph before introducing boundaries. `recipe-policy` and `recipe-lifecycle` are moderate-size modules used by recipe workspace, moderation, admin content, OpenAPI composition and application wiring. They are suitable for proving an incremental pattern without beginning the large family, subscription, AI or meal-plan decompositions.

Before this checkpoint, consumers imported service, contract and helper implementation files directly. `RecipeLifecycleService` also contained pure reason sanitization and lifecycle projection alongside Kysely orchestration.

## Decision

Both pilot modules expose one explicit `public.ts` API:

- `recipe-policy/public.ts` exports the controller/service façade, validated public schemas/types and pure quota policy.
- `recipe-lifecycle/public.ts` exports the application service façade and pure lifecycle projection/reason policy.

All consumers outside each module import only that module's `public.ts`. The architecture gate scans TypeScript and runtime MJS consumers under `src`, `test` and `scripts`; a deep import into either pilot module fails.

Pure behavior is separated without introducing ceremonial layers:

- `recipe-policy.domain.ts` owns action-window selection and the default validated policy value.
- `recipe-lifecycle.domain.ts` owns public-reason sanitization and the review/publication projection.
- Existing injectable services remain application façades and retain all Kysely statements, locks, transaction participation, authorization ordering and exception behavior.

No repository abstraction is added because these services operate on transaction-scoped SQL workflows rather than a replaceable aggregate store. No module directory is moved.

## Compatibility and evidence

- HTTP routes, request/response schemas, OpenAPI and status codes are unchanged.
- Database queries, locking order, audit writes, idempotency and transaction ownership are unchanged.
- `RecipePolicyController`, `RecipePolicyService` and `RecipeLifecycleService` retain their class identities; only external import paths change.
- Application wiring, OpenAPI response composition, recipe workspace, moderator/admin content, acceptance scripts and tests use the public APIs.
- Pure projection tests cover pending normalization, hidden override, publication preservation and bounded public reasons.
- Architecture tests independently enumerate consumers and reject non-public pilot imports.

## Consequences

- These two modules now demonstrate the approved boundary pattern without forcing empty application/domain/infrastructure directories.
- Their internal filenames may evolve while external consumers remain stable at `public.ts`.
- The existing module-level dependency graph remains 148 edges; this checkpoint changes import surfaces, not dependencies.
- Other modules are not yet required to provide `public.ts`; expansion happens one reviewed context slice at a time.
