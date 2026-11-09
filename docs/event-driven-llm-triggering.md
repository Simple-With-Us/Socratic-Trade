# Event-Driven LLM Triggering

Run the (expensive) LLM strategy pipeline **when a material event arrives** instead of only on a
fixed clock — cutting token cost and improving responsiveness without over-trading. Policy
designed by a 4-expert panel (systematic trader / risk manager / LLM-ops / microstructure);
this doc is the reconciled spec + current implementation status.

## Modes
- `interval` — today's behavior: fixed `runCadenceMinutes` cadence.
- `event` — runs only fire from material events (interval lane disabled).
- `both` — interval floor (recommended 90 min) **plus** a gated event lane. Recommended default.

**Master switch:** `TRIGGER_ENGINE` (default **off** → pure interval, zero behavior change).

## Current implementation status (Phase 0/2 scaffold — `src/lib/triggers.ts`)
**Implemented now (default OFF):**
- Mode switch (`TRIGGER_ENGINE`, `TRIGGER_MODE`); scheduler skips the interval lane in `event` mode.
- `submitMaterialEvent(userId, event)` + `broadcastMaterialEvent(event)` (fan-out to active users).
- **Debounce/coalesce** (quiet window + hard ceiling + max-batch) → a storm of events = ONE run.
- **`admitRun` gate**: engine/mode, system active, account selected, market hours
  (`isRunAllowedNow`), global cooldown, per-symbol cooldown, hourly + daily caps.
- **Idempotency**: dedup by `type:symbol:sourceId` with a TTL.
- **One producer wired**: SEC 8-K — a fresh filing with a material item code
  (`eightKHasMaterialItem`, allowlist `1.01/1.02/1.03/2.01/2.02/4.01/4.02/5.02`) broadcasts an event.
- Audit of `trigger_run` / `trigger_suppressed`; dev route `GET/POST /api/admin/trigger-test`.

**Deferred (documented for later phases):**
- Per-user `triggerConfig` policy fields (the schema was just migrated; env config ships first).
- Other producers: regime flip (highest value), insider-buy, technical push, congress (default off).
- Fills are **deterministic-only** (re-arm brackets) and must **NOT** trigger an LLM run.
- Per-ticker run SCOPE (today an event triggers a full scan run), after-hours event queue,
  $/token budget ceiling (Phase 3, once Langfuse usage flows), live-mode stricter overrides.

## Event → action (the policy)
| Event | Action | Materiality | Scope |
|---|---|---|---|
| Regime flip | LLM only on flip *into* Risk-Off/Crisis/Inverted (else re-score label) | state change, 2-poll confirm; Crisis fires immediately | book |
| Order fill | **deterministic only — never an LLM run** (re-arm brackets, emit `order`) | always processed | symbol |
| SEC 8-K | LLM | item code ∈ allowlist | ticker, held/watchlist |
| Insider Form-4 | LLM, **buys only** | ≥$100k OR ≥2 insiders/7d OR CEO/CFO | ticker, held/watchlist |
| Congress | enrichment by default (`enabled:false`) | ≥$250k OR ≥2 members/7d | ticker, held/watchlist |
| Technical push | LLM, gated | score ≥75 (≤25 exit) + structural signal + 4h cooldown | ticker, held/watchlist |
| Breadth flip | feeds regime — never triggers alone | — | — |

## Guardrail defaults (env, paper-mode)
| Env | Default | Meaning |
|---|---|---|
| `TRIGGER_ENGINE` | off | master kill-switch |
| `TRIGGER_MODE` | both | interval / event / both |
| `TRIGGER_DEBOUNCE_MS` | 90000 | quiet window before firing |
| `TRIGGER_MAX_DEBOUNCE_MS` | 300000 | hard ceiling from first event |
| `TRIGGER_MAX_BATCH` | 25 | fire immediately at this many events |
| `TRIGGER_GLOBAL_COOLDOWN_SEC` | 300 | min seconds between runs |
| `TRIGGER_PER_SYMBOL_COOLDOWN_SEC` | 1800 | per-symbol re-trigger cooldown |
| `TRIGGER_MAX_RUNS_PER_HOUR` | 6 | hourly event-run cap |
| `TRIGGER_MAX_RUNS_PER_DAY` | 24 | daily run cap |
| `TRIGGER_DEDUP_TTL_SEC` | 86400 | idempotency window |

Crisis/Risk-Off regime overrides, the live-mode stricter block, and the per-user policy mirror
are specified in the panel output and deferred to a later phase.

## Rollout (panel)
- **Phase 0** (done): plumbing, default off, zero behavior change.
- **Phase 1** (done): deterministic Tier-0/1 — no LLM, no cost:
  - **Regime flip detector** (`src/lib/regime-watch.ts`) on the scheduler tick: persists the label
    (`regime:current`), audits `regime_flip`, pushes a dashboard refresh + a (non-triggering)
    material event on a change. Seeds silently first run.
  - **Real-time fill handling**: the Alpaca `trade_updates` WebSocket worker
    (`src/lib/streams/alpaca-trade-updates-stream.ts`) → `onBrokerFill` (`src/lib/fills.ts`)
    reconciles the fill against the broker immediately + emits a dashboard `order` event. Fills are
    **deterministic-only** — they do not trigger an LLM run. Opt-in `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`.
  - **NOTE on "re-arm brackets":** true resting bracket/OCO orders do **not** exist in this codebase
    (only a per-run `generateProactiveRiskProposals` threshold check). So Phase 1 does reconcile +
    dashboard push on fill; auto re-running the risk check on every fill (which would place market
    exits outside a run) is intentionally deferred as a behavior change.
- **Phase 2** (partially started — 8-K producer): event lane on behind `admitRun`, run-count budget;
  enable regime/8-K/insider/technical; keep congress/breadth off; default `mode=both`, cadence 90.
- **Phase 3**: token/$ budget ceiling + tuning from event→run→P&L data.

## To turn it on (when ready)
Set `TRIGGER_ENGINE=on` (and optionally `TRIGGER_MODE=both`, `runCadenceMinutes=90`). Verify the
gate with `GET /api/admin/trigger-test` (shows `admitPreview`), and submit a synthetic event with
`POST /api/admin/trigger-test`.
