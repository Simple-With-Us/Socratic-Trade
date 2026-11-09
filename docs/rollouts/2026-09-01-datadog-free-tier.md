# 2026-09-01 — Datadog Free-tier LLM Observability (Grok, `grok/datadog-free-tier`)

- Canonicalize `DD_ENV=prod` to `production`.
- Wrap `llmFetch` / `llmFetchCapturing` with Datadog LLMObs (`ml_app=socratic-trade`).  One LLM span per provider call.  Daily cap 1,200.  No prompt contents.  Sentry `gen_ai` spans stay separate — do not put `gen_ai.*` on Datadog APM.
- Tracer init enables `llmobs` and keeps profiling off.
