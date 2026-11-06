# ADR-004: acyclic capability modules during context migration

- Status: accepted
- Date: 2026-11-03
- Scope: Nest composition migration
- Depends on: [ADR-001](ADR-001-backend-bounded-context-baseline.md), [ADR-003](ADR-003-catalog-recipes-composition-boundary.md)

## Context

The 148-edge module baseline collapses into eight logical bounded contexts, but the current context-level graph contains two strongly connected components:

1. Operational SCC: `household-entitlements`, `identity-access`, `integrations`, `platform-operations`.
2. Product SCC: `catalog-recipes`, `community-content`, `inventory-commerce`, `planning-health`.

These SCCs describe current source dependencies, not desired Nest module imports. Creating one Nest module per bounded context immediately would require circular imports between both groups.

## Decision

One Nest module per bounded context remains the target state. During migration, composition is extracted through small acyclic capability modules whose ownership and exports are explicit.

The following are rejected:

- `forwardRef` as a way to preserve or hide a context cycle;
- merging either SCC into a mega-context or mega-module;
- duplicating a provider in root and capability modules;
- capability modules that export internal repositories, controllers or unrelated providers;
- empty application/domain/infrastructure layers introduced only for symmetry.

A capability is eligible when its DI graph can be imported without a Nest cycle, it has one clear owner, and existing consumers can receive the same exported singleton without changing runtime contracts. Every extraction must retain an exact OpenAPI regression and provider-identity evidence.

## Entitlements capability

`EntitlementsCapabilityModule` is the next approved slice under `src/contexts/household-entitlements/`. It owns:

- `EntitlementsController`;
- `EntitlementsService`.

It exports only `EntitlementsService`. Database and user-session guard dependencies come from the existing global `CoreRuntimeModule`; the capability imports no peer context module and therefore adds no Nest cycle.

All source, shared, test and worker consumers use `entitlements/public.ts`. The HTTP `AppModule` imports the capability and no longer declares its controller/service. The separately bootstrapped worker context continues to declare its own worker-scoped `EntitlementsService`, imported through the public API; it does not import an HTTP controller module.

## Evidence

- Architecture gate rejects deep imports into `entitlements` in addition to the recipe pilot modules.
- Static composition regression rejects root ownership of the entitlements controller/service.
- Runtime regression verifies that the controller and a representative existing consumer receive the same capability-owned service instance.
- Exact generated OpenAPI comparison and the complete backend suite protect wire and behavior compatibility.

## Consequences

- The context SCCs are now explicit migration constraints rather than reasons to introduce circular Nest wiring.
- The household context is not considered fully extracted; only the entitlements capability has moved.
- Later capabilities must reduce direct edges before they are consolidated into final bounded-context modules.
- No HTTP, OpenAPI, database, transaction, authorization or worker behavior changes in this checkpoint.
