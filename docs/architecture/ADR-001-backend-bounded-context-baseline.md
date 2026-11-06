# ADR-001: backend bounded-context and dependency baseline

- Status: accepted
- Date: 2026-11-03
- Scope: `meal_backend`

## Context

Backend remains one NestJS/Fastify/Kysely modular monolith. Its 67 current modules have no dependency cycles, but 148 direct cross-module import edges are not represented by explicit public context APIs. Moving modules, changing providers or altering HTTP/database contracts before recording the current topology would make an incremental migration difficult to review and easy to broaden accidentally.

This checkpoint records ownership and freezes the existing dependency graph. It does not declare every current edge desirable and does not change runtime composition.

## Decision

The machine-readable source is [`backend-context-map.json`](backend-context-map.json). Every first-level directory under `src/modules` must belong to exactly one of these logical contexts:

| Context                  | Responsibility                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `identity-access`        | Authentication, accounts, profiles, consent/privacy and account lifecycle          |
| `household-entitlements` | Families, memberships, subscription settings and entitlement views                 |
| `catalog-recipes`        | Products, recipes, lifecycle/policy, cooking, preserves and catalog search         |
| `inventory-commerce`     | Inventory intake, shopping, receipts, finance, payments and billing operations     |
| `planning-health`        | Meal planning, diary, nutrition, recommendations and personalization               |
| `community-content`      | Community, moderation, releases, support, appeals and content operations           |
| `platform-operations`    | Administrative control plane, acceptance, observability, maintenance and telemetry |
| `integrations`           | AI, delivery, media/OCR/storage, notifications, provider runtime and Web Push      |

Ownership is logical rather than physical for now: directories are not moved and existing imports remain unchanged. Admin-prefixed modules that implement a domain workflow belong to that domain; generic admin control-plane modules belong to `platform-operations`.

`npm run check:architecture` enforces all of the following:

1. Domain modules do not import `src/app`.
2. The module graph remains acyclic.
3. The approved context set is exact and every current module is assigned once.
4. Context lists and dependency edges are sorted and duplicate-free.
5. Every current direct cross-module import has one exact baseline edge.
6. A new unapproved edge fails the check.
7. A removed edge leaves a stale baseline and also fails until the map is deliberately updated.

An edge baseline update therefore must be reviewed together with the code that added or removed it. Adding an edge requires an explanation of why an existing public API, port or event cannot be used. Removing an edge is preferred and should delete its baseline entry in the same change.

## Consequences

- Current runtime, Nest providers, API, OpenAPI and database contracts are unchanged.
- The 148 baseline edges are recorded debt, not a target design or blanket approval for similar dependencies.
- Future checkpoints can introduce context modules and `public.ts` boundaries with a measurable, fail-closed ratchet.
- A module cannot be silently created, renamed, moved between contexts or deleted without updating the ownership map.
- Exact baseline comparison intentionally creates review friction; architecture changes are explicit rather than inferred.

## Migration direction

1. Preserve this baseline while extracting context-local Nest composition modules.
2. Pilot `public.ts` and application/domain/infrastructure boundaries in a moderate context.
3. Replace direct cross-context imports one use case at a time and remove the corresponding baseline edges.
4. Add direction rules only after compatible public boundaries exist; do not mass-move the current modules.
5. Keep HTTP, OpenAPI and database compatibility checks green throughout the migration.
