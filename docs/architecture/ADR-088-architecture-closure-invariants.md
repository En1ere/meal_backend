# ADR-088: Architecture closure invariants

- Status: accepted
- Date: 2026-11-04
- Scope: static architecture enforcement
- Depends on: [ADR-003](ADR-003-bounded-context-ownership-map.md), [ADR-084](ADR-084-legal-runtime-public-boundary.md), [ADR-085](ADR-085-web-push-public-boundary.md), [ADR-086](ADR-086-account-mail-public-boundary.md), [ADR-087](ADR-087-media-processing-public-boundary.md)

## Context

Public-boundary enforcement previously depended on a manually maintained module list. Capability modules had focused composition tests, but no generalized static guard against a new cycle, `forwardRef`, unreachable context module or duplicate statically declared controller/provider token.

All 67 mapped domain directories now have `public.ts`. The only remaining deep-import debt is the foundational `auth` module: 149 exact current consumer/target pairs use implementation entry points that are not yet represented by its narrow public API. Migrating that cross-cutting API is a separate compatibility checkpoint, not a checker-only change. The four closure gaps (`account-mail`, `legal-runtime`, `media-processing`, `web-push`) have no such debt.

## Decision

- Derive domain public-boundary coverage from every module assigned in `backend-context-map.json`.
- Require `public.ts` for every mapped module and forbid `export *` in every module public API.
- Keep no missing-public exceptions. The checker supports a documented exception only when the module is not externally imported; stale or externally used exceptions fail closed.
- Record the exact current `auth` deep-import set as a count plus SHA-256 ratchet. Any addition, removal or target/consumer substitution fails until the baseline is deliberately migrated.
- Parse balanced `@Module` metadata for all context module files and validate identifier-only Nest imports, context reachability from `AppModule`, cycles, `forwardRef`, duplicate controller ownership and duplicate provider/token ownership.
- Permit duplicate `APP_GUARD` ownership only for the exact two root `AppModule` enhancers.
- Preserve the independent 148-edge domain dependency ratchet.

## Static parser limit

The checker is deliberately AST-free. It proves only balanced static arrays containing bare identifiers and provider objects with an identifier `provide` token. An unsupported computed/spread/dynamic declaration fails as “not statically resolvable”; the checker does not guess. Dynamic root ownership is limited to the current `CoreRuntimeModule` and `AppModule` provider arrays, while runtime composition tests remain authoritative for instantiated singleton identity and OpenAPI equality.

## Evidence

- Focused architecture tests verify all mapped public APIs, the four closed gaps and the generalized checker.
- The checker covers 80 context module files and the complete reachable capability graph.
- Full type, build, lint, test and generated-schema gates remain unchanged.

## Consequences

- New module directories cannot silently fall outside public-boundary enforcement.
- Wildcard public exports, hidden capability cycles and statically duplicate ownership fail before runtime.
- Auth boundary debt is visible and cannot grow, while its eventual migration remains an explicit follow-up rather than a hidden mass rewrite.
