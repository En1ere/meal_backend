# ADR-003: catalog recipes Nest composition boundary

- Status: accepted
- Date: 2026-11-03
- Scope: HTTP application composition
- Depends on: [ADR-001](ADR-001-backend-bounded-context-baseline.md), [ADR-002](ADR-002-recipe-boundary-pilot.md)

## Context

ADR-002 established public code boundaries for recipe policy and lifecycle, but `AppModule` still owned their controller and service providers directly. Extracting the first Nest module must preserve provider identity: existing root-owned recipe workspace, moderator and admin-content services inject the same exported recipe services, while recipe policy guards must resolve the same authentication/runtime providers as every other controller.

`UserSessionGuard` and `AdminSessionGuard` depend on `AuthCookies`; `AuthService` and `AdminAccessService` depend on the application config and database. Therefore the smallest safe shared runtime boundary contains those seven providers/tokens and nothing else.

## Decision

`CoreRuntimeModule` is a global dynamic module configured once by the HTTP `AppModule`. It owns and exports exactly:

- `APP_CONFIG`;
- `DatabaseService`;
- `AuthService`;
- `AdminAccessService`;
- `AuthCookies`;
- `UserSessionGuard`;
- `AdminSessionGuard`.

`AuthCookies` is included only because both session guards require the same config-bound cookie naming and parsing instance. CSRF, staff/moderator guards, global network guards, telemetry, workers and provider adapters remain in the root composition.

`CatalogRecipesModule` owns:

- `RecipePolicyController`;
- `RecipePolicyService`;
- `RecipeLifecycleService`.

It exports the two services so existing root providers consume the same module-owned instances. `AppModule` imports both modules and no longer lists those controller/providers or any core-owned provider itself.

The separately bootstrapped `WorkerModule` is intentionally unchanged. It is a different Nest application context/process and continues to own its worker-scoped database/auth providers.

## Evidence

- Static composition regression verifies that none of the extracted tokens/classes remains in root providers/controllers and each core provider is declared once.
- Runtime regression starts the real Fastify/Nest application and verifies that recipe policy, controller, user/admin guards, auth, cookies, access and database share the exact injected singleton instances.
- The runtime regression compares the generated OpenAPI document to `contracts/openapi.json` exactly.
- Existing HTTP, guard, recipe workspace, moderator and admin-content suites remain the behavioral compatibility evidence.

## Consequences

- This is the first real context-local Nest composition boundary; it does not move domain modules or change the 148-edge dependency baseline.
- `AppModule` remains the legacy composition root for all other contexts.
- No route, schema, SQL, transaction, guard order, global guard or worker behavior changes.
- Future context extraction should reuse this ownership/export pattern only where dependency analysis proves a single provider graph; it must not duplicate global providers in feature modules.
