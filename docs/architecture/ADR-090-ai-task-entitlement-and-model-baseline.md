# ADR-090: AI task entitlement and model baseline

- Status: accepted
- Date: 2026-11-06
- Scope: AI task availability, provider model baseline and data minimization
- Depends on: [ADR-062](ADR-062-ai-capability.md), [ADR-088](ADR-088-architecture-closure-invariants.md)

## Context

The existing `ai-task-policy-v2` classified 18 task codes and their action cost, but task availability was not authorized against the effective subscription. A Free user with a purchased, trial or administrative bucket could preview any Pro-labelled task. Plus users could also select tasks whose product meaning depends on Pro-only nutrition or finance capabilities.

The same generic provider prompt handled every task and the only optional personal source was a snapshot of up to 50 private inventory batches. The task names therefore promised more context than the backend actually supplied. `seasonal_analysis` has no authoritative seasonality dataset, while `document_analysis` has no owned document reference or safe file-ingestion input.

Current official OpenAI guidance positions GPT-6 Luna for focused high-volume work and GPT-6.1 Sol for more complex work where quality must be balanced with cost. Both support the Responses API and Structured Outputs. The current provider already sends foreground requests with `store: false`; local product retention remains a separate 30-day policy.

## Decision

Adopt `ai-task-policy-v3` as the immutable entitlement baseline.

- AI actions are a consumption balance, not a feature unlock. Trial, purchased, transferred and administrative compensation buckets never elevate the subscription plan.
- `GET /ai/capabilities` is account-scoped and returns only task codes authorized by the effective entitlement.
- The backend repeats the same authorization at preview, initial reservation and every continuation. A stale or forged client catalog cannot bypass it.
- Free keeps prompt-, recipe-, inventory-, catalog-, review- and preference-based scenarios that belong to its existing domains.
- Plus adds generated shopping lists, multi-range meal planning and event-menu planning.
- Pro adds personal nutrition calculation and portion cost calculation because their product meaning depends on Pro nutrition/finance data.
- `seasonal_analysis` and `document_analysis` remain known contract codes but fail closed until an authoritative dataset and an owned bounded document-input contract exist.
- A task may use only sources available to the current tariff. Future full-context work must define required and optional sources per task, record consent/version evidence and freeze the exact bounded context manifest before reservation.
- AI output never mutates a domain directly. Structured output is validated and shown as a domain preview; a separate confirmed domain command owns any write.

Use OpenAI Responses API with `store: false`. Keep `gpt-6-luna` with low reasoning as the launch baseline because the workload is frequent and scoped. Build representative evals before enabling `gpt-6.1-sol` for heavy tasks; a quality escalation must be a versioned provider profile, not a hard-coded task branch. GPT-6 Astra is not part of the launch cost baseline.

The model profile must eventually persist requested/actual model, reasoning effort, input/output/reasoning tokens, provider request id, latency and estimated/actual provider cost. Secrets stay in root-owned runtime secret files and are never returned by user or admin APIs.

## Consequences

- Free + package can use Free AI scenarios without acquiring Plus/Pro context.
- Plus cannot invoke nutrition or finance AI tasks merely because it has an action balance.
- Catalog caching must be account-scoped in the frontend and invalidated after subscription/trial changes.
- Two ambiguous task codes temporarily disappear from every effective catalog instead of returning misleading results.
- The next backend slice must introduce versioned per-task context/source and structured-output contracts, followed by the asynchronous operation lifecycle and read-only admin control plane.
- Model selection remains measurable: compare Luna and Sol on the same accepted fixtures, tracking task success, latency, token usage and cost per successful result.

Official references: [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection), [GPT-6 models](https://developers.openai.com/api/docs/models), [API pricing](https://developers.openai.com/api/docs/pricing), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [data controls](https://developers.openai.com/api/docs/guides/your-data).
