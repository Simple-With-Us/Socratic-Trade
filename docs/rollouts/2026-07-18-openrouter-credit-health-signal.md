# 2026-07-18 — OpenRouter prepaid-credit signal on /api/health (external-monitor watchdog) (MONET)

## Summary

`/api/health` now surfaces the OpenRouter prepaid-credit balance so an EXTERNAL monitor (Uptime
Robot) can alert the owner when the money runs low — before it takes the whole LLM+RAG decision
loop offline. No in-app alerting and no provider fallback (owner-directed): the app only *reports*
the balance; an external watchdog decides to alert.

## Why

Universal OpenRouter routing (#1703) made OpenRouter the single point of failure for every LLM
call AND all RAG embedding. When its prepaid credits ran out, the entire decision loop went dark
(strategy, chat, post-mortems, SEC backfill) — a real incident on 2026-07-18
(`docs/rollouts/2026-07-18-worktree-cleanup-voyage-rca.md`). The owner keeps OpenRouter on a
deliberately low credit cap (cost guard) and wants an external alert if it ever runs dry — not an
in-app alert (only as trustworthy as the app that may be failing) and NOT an automatic fallback to
other providers.

## What

- New `src/lib/openrouter-credits.ts`: `getOpenRouterCreditStatus()` — resolves the operator
  OpenRouter key (`local`'s per-user store, where the env key is migrated at boot), queries the
  FREE `GET /credits` endpoint (no LLM tokens), and returns `{ ok, remainingUsd, totalUsd, usedUsd,
  thresholdUsd, checkedAt }`. `ok=false` ONLY when the balance was read and is below the threshold.
  Cached (default 10 min, `OPENROUTER_CREDIT_CHECK_INTERVAL_MS`) so a frequent health poll never
  hammers it. A read failure (network/5xx/401) FAILS OPEN (`ok=true` + `error`, last good value kept)
  so a monitor never pages on our own inability to read the balance. Returns `null` (no signal) when
  no OpenRouter key is configured.
- `app/api/health/route.ts`: adds `dependencies.openrouter = { ok, degraded }` and a human-readable
  `checks.openrouterCredits = { ok, remainingUsd, … }`. Low balance DEGRADES the probe but NEVER
  503s it — a restart can't refill credits and would just restart-loop. Best-effort (never breaks
  the probe).
- Threshold configurable via `OPENROUTER_LOW_CREDIT_USD` (default $10). Documented in `.env.example`.

## Uptime Robot monitor (the external half — owner-directed setup)

Point a **Keyword** monitor at `https://socratictrade.com/api/health`:
- Keyword: `"openrouterCredits":{"ok":false`
- Alert when: keyword **exists** (compact JSON puts `ok` first, so this substring is stable)
- Interval: 5 min
- Alert contact: `mail@jays.services` (email; UR sends a click-to-confirm)

This fires only on a genuinely-low balance (not on a transient read failure). Setting the monitor
requires the Uptime Robot API key (not present in the sanctioned secret locations) or the UR
dashboard — handed to the owner separately.

## Verification

`tsc --noEmit` clean; `test/openrouter-credits.test.ts` 5/5 (threshold ok/low, fail-open on read
error, cache/no-hammer, null when unconfigured); full suite + `npm run build` via `scripts/land.sh`.

## Follow-ups

- Create the Uptime Robot monitor (needs the UR API key via secret handoff, or owner does it in the
  dashboard with the config above).
- Optional: basic uptime monitors for the other apps ("Uptime Robot for all apps").
