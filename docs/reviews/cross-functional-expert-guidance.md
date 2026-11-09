# Cross-Functional Expert Guidance

Consolidated guidance from non-UI expert panels and review tracks: strategy,
architecture, financial soundness, LLM/prompt hygiene, market-data operations,
event-triggering, multi-account isolation, and cost/ops standards. Use this as
the entry point before changing backend trading behavior, data providers, LLM
calls, learning loops, account handling, or automation.

## Source Notes

- `docs/reviews/2026-06-18-architecture-strategy-review.md` - platform-deep-review
  architecture/strategy/LLM track.
- `docs/event-driven-llm-triggering.md` - reconciled 4-expert panel
  (systematic trader, risk manager, LLM-ops, microstructure).
- `docs/data-architecture-push-vs-poll.md` - push-vs-poll and compute-offload
  principles.
- `docs/rollouts/2026-06-18-massive-full-util-accounts-modal-review.md` -
  multi-agent platform review source and fixed cache-poisoning issue.
- `docs/rollouts/2026-06-19-vwap-emits-ws-worker-trigger-engine.md` - trigger
  engine implementation and expert-panel follow-ups.
- `docs/rollouts/2026-06-19-market-data-sharing-guardrails.md` - shared/private
  market-data cache boundaries.
- `docs/rollouts/2026-06-19-market-data-pending-demand.md` - pending-demand and
  shared fill behavior.
- `docs/rollouts/2026-06-19-phase-10-11-learning-isolation.md` - learning and
  user/account isolation work.
- `docs/rollouts/2026-06-19-ops-observability-security.md` - ops, tracing, and
  security guardrails.

## Durable Standards

1. **Policy gates are the source of truth.** LLM output is advisory until it
   passes deterministic policy checks. Risk-reducing exits still need to flow
   through the same review/accounting path unless explicitly documented
   otherwise.
2. **Proactive risk exits are a top backend priority.** Stop-loss,
   take-profit, trailing-stop, and crisis de-risking settings must either be
   enforced or clearly labeled as not yet active. Do not leave configurable
   controls that imply protection when no runtime path exists.
3. **Learning must be account/user scoped and join-correct.** Outcome scorecards,
   skipped-counterfactuals, factor efficacy, confidence calibration, and
   strategy tuning should not mix accounts, users, modes, or mismatched symbol
   keys. Add targeted fixtures before trusting new learning reads.
4. **LLM calls need bounded, deterministic hygiene.** Use explicit sampling
   controls where supported, strict JSON schemas, max-output caps, prompt
   compaction, and real cache semantics. Remove comments that claim caching or
   determinism before they are implemented.
5. **Prompt context must distinguish execution modes.** The backend should tell
   LLMs `mock/local` vs live, and must not call local simulated fills Paper mode.
6. **Event-triggered LLM runs must be gated.** The trigger engine stays default
   off until configured. Event lanes need debounce/coalescing, global and
   per-symbol cooldowns, hourly/daily caps, idempotency, market-hours admission,
   and later a token/$ budget ceiling. Fills re-arm brackets deterministically;
   fills should not trigger an LLM run.
7. **Use push/streaming where it reduces blind polling, but keep recovery paths.**
   SSE/dashboard events, broker/news streams, and shared cache fills should
   refresh open dashboards. Polling remains a slower fallback for missed events.
8. **Never fabricate market data.** No synthetic mock/fallback numbers next to
   real data. Show `-`/`n/a`, freshness, and provider source attribution when a
   value is missing or not meaningful.
9. **Cache only successes and respect data boundaries.** Public/env-key market
   data can be shared when documented. User-keyed data remains private unless an
   explicit opt-in says otherwise. Failed or empty source responses must not
   poison long-lived caches.
10. **Extra data bridges are low-trust by default.** Unofficial or fragile data
    sources should be read-only, opt-in, clearly sourced, never used for order
    execution/fills, and disabled without breaking core behavior.
11. **Keep recommendations cost-aware.** Prefer free or nearly-free defaults;
    put expensive RAG/LLM/provider paths behind caps, batching, pacing, or
    explicit enablement.
12. **Broker/account state should be inspectable.** Robinhood MCP, Alpaca,
    active account, environment, credentials, and transport health need visible
    diagnostics so users and agents can distinguish local bugs from upstream
    access problems.
13. **Ops and observability must be redacted by default.** Traces, logs, Sentry,
    Langfuse, backups, and security scans should avoid leaking account numbers,
    credentials, prompts, or personal trading details.

## Implemented From The Panels

- Mock/Local execution mode is sent to LLM-facing strategy/tuning/red-team paths.
- Strategy tuning remains review-only until the user applies changes.
- Market-data sharing boundaries distinguish public/env-key cache from private
  user-keyed history.
- Pending market-data demand records allow later shared public fills to refresh
  prior requesters without spending another user's private key.
- Event-trigger engine exists behind env gates with debounce, cooldown, caps,
  idempotency, and a material 8-K producer.
- Dashboard SSE events reduce blind polling for run/order/proposal updates.
- Massive grouped data and VWAP paths support richer scan/history context, with
  S3 entitlement limitations documented.
- API-key routing and connected-account credential storage are server-side and
  user scoped.

## Open Follow-Ups

- Build the risk-exit engine so configured stop/take-profit/trailing exits
  actually generate gated sell/cover proposals.
- Audit learning-loop joins end-to-end with fixtures for symbol keys, userId,
  account, source mode, recency weighting, and size weighting.
- Add explicit LLM sampling/output caps and either implement prompt caching or
  remove claims that it exists.
- Move macro/breadth/history cold-start work further off the request path.
- Add per-user trigger configuration, per-ticker run scope, after-hours event
  queueing, and token/$ budget ceilings before enabling event mode broadly.
- Expand backtesting/historical validation using Massive bulk bars or another
  maintained data source before trusting strategy changes in Live mode.
- Keep short/cover behavior disabled or heavily guarded until accounting,
  exposure, broker support, and daily-notional tests are complete.
