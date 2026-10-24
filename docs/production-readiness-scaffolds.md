# Production readiness scaffolds

The repository keeps provider-neutral, versioned manifests in `config/production-readiness`. They are
intentionally `blocked`: a syntactically valid manifest does not approve a provider, KPI, cacheable route or deployment.

- `cache-policy.v1.json` keeps private, security-sensitive and dynamic responses uncached. Only fingerprinted static
  assets have an immutable policy. Public route caching stays empty until a route-by-route data and invalidation review.
- `deployment-strategy.v2.json` records a blue/green target shape, schema v26 and the pre-traffic gates. It does not
  choose a platform, create infrastructure or switch traffic. The v1 file remains historical and is not accepted by the
  current validator.
- `kpi-catalog.v1.json` reserves the approved product-metric groups but defines no KPI, formula, dimension, target or
  privacy threshold without an owner decision and validated data source.
- `browser-support.v1.json` binds automated coverage to Chromium, Firefox and WebKit plus the required physical
  iOS/Android and assistive-technology acceptance. Exact release versions and evidence are recorded only at release.
- `security-headers.v1.json` fixes the minimum HTTPS/header posture and the report-only-to-enforced CSP rollout. Header
  ownership, production origins, report endpoint and an external probe are still required.
- `scheduler.v1.json` mirrors worker topology v1, keeps every task disabled and defines no schedules/provider until
  leases, telemetry and alerting are accepted.
- `payment-methods.v1.json` defines only the safe provider boundary for listing and revoking saved methods. It permits
  opaque provider references and display metadata, never sensitive card data; no user API or UI is implied.

Run `node scripts/check-production-readiness.mjs` to validate the blocked manifests. The validator also rejects drift
from the prepared database manifest, Playwright projects, backend worker topology and the application Helmet/no-store
baseline. `--require-ready` deliberately returns a non-zero status until later versioned manifests are introduced and
approved.

The payment-method boundary intentionally stops before an HTTP contract. Provider selection must confirm whether
listing is authoritative at the provider or synchronized locally, what identifier can be detached, and how an unknown
detach result is reconciled. Only then may a separately reviewed user API and UI be added. Revocation must preserve
historical payments and must not be treated as a refund or subscription cancellation.

Deployment order is fail closed: verify the immutable artifact and schema-v26 compatibility, keep workers disabled,
verify headers and browser evidence on the inactive slot, prove backup/restore evidence, then perform a manually
verified traffic switch. The manifests do not execute any of these steps.

## Read-only production browser acceptance

`node scripts/production-acceptance.mjs` only prints a blocked plan. Supplying `--target target.json` validates and
prints a plan, but still does not start a browser. A run requires all of `--execute`, `--target` and a new `--output`
path. The target must contain three exact public HTTPS origins, exact release versions, an acknowledgement timestamp and
`allowMutations: false`.

During an explicit run, every non-GET/HEAD/OPTIONS request is aborted and makes the run fail. The runner uses anonymous
browser contexts, stores no credentials and writes a contract-compatible evidence object only when all checks pass.
Never point the existing mutation-oriented `e2e` suite at production.
