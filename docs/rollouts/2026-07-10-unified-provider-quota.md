# 2026-07-10 — Unified, scan-size-agnostic provider request quota

## Summary

Replaced the bespoke, Twelve-Data-only credit-window gate with ONE uniform request-quota
primitive (`RequestQuota` in `src/lib/provider-rate-limit.ts`) that any rate-limited data
provider can consult. A provider declares its real free-tier limits as a list of sliding
windows (per-minute / per-hour / per-day); `admitProviderRequests(provider, credKey, wanted)`
returns how many of `wanted` outbound requests fit under ALL of those windows right now,
records them, and never blocks. Callers query the admitted best-first symbols and defer the
rest best-effort (empty `{}`, negative-cached if genuinely no data) — so a scan is **capped by
the provider's real rate limit, not by a hardcoded symbol count**, and behaves correctly no
matter how many tickers are in the scan.

This is the owner's directive made concrete: *"it needs to be based on not knowing how many
tickers will be in the scan so it is flexible and all other data provider settings also need to
be that way."*

## Why

- **Tiingo was 403ing** (owner's dashboard showed the hourly meter at −10/50): a 30-symbol scan
  fires ~90 requests (3 sub-calls/symbol) against a **50/hour** cap. Spacing can't fix an hourly
  cap without stalling every scan for an hour, so Tiingo must **budget** the top-N symbols.
- **Twelve Data** sends one batch `/quote` call costing **1 credit per symbol** against **8
  credits/min** — you can't space a single batch call, so it must cap the batch size.
- The previous fix for Twelve Data was a private per-provider window helper. Rather than clone
  that logic per provider, the quota is now a shared primitive with per-provider config.

## Pacer vs. quota (the design split)

Two orthogonal controls now live in `provider-rate-limit.ts`:

- **PACER** (`withProviderLimit`, pre-existing): concurrency + `minIntervalMs` spacing. Right for
  providers whose cap is **per-minute** and whose calls are **per-symbol** — it covers EVERY
  symbol over time (just slower for bigger scans) and is itself scan-size-agnostic. Used by
  **finnhub (60/min), yahoo, alpha-vantage (~1/sec + 25/day via the key pool)**. These are
  deliberately NOT quota'd — a quota would needlessly drop coverage they can otherwise get.
- **QUOTA** (`RequestQuota` / `admitProviderRequests`, new): a pure sliding-window counter for
  providers with a hard windowed cap that pacing can't solve. Used by **twelvedata (8/min +
  800/day)** and **tiingo (50/hour + 1000/day)**.

Key properties of the quota:
- **Per-credential** (`provider|credKey`, djb2 fingerprint of the key): two accounts sharing one
  operator key share the budget; distinct keys have independent lanes.
- **Multi-window**: admits the MINIMUM headroom across all of a provider's windows.
- **Instantaneous**: never blocks/queues — the caller defers what isn't admitted (no scan stall).
- **Env-overridable**: `PROVIDER_QUOTA_<NAME>_PER_MIN|_PER_HOUR|_PER_DAY` replaces/adds a window;
  a value `<= 0` removes it. Lets the owner retune any provider without a deploy.
- Does NOT honor `PROVIDER_RATE_LIMIT_DISABLED` (that switch exists to skip real pacing *delays*;
  the quota adds none, and disabling it would let a scan blow a real free-tier cap).

## Files

- `src/lib/provider-rate-limit.ts` — new `RateWindow`, `RATE_QUOTAS` (twelvedata + tiingo only),
  `resolveProviderQuota` (with env overrides), `RequestQuota` class (injectable clock),
  `admitProviderRequests`, `resetProviderQuotaState`.
- `src/lib/data-providers.ts` — generic `apiKeyFingerprint` (djb2), `providerNegativeTtlMs`
  (env `PROVIDER_NEGATIVE_TTL_MS`, default 30 min), `callsPerSymbol` (tiingo 3/2, else 1);
  Twelve Data + Tiingo enrich gates now call `admitProviderRequests`; Tiingo also honors
  `TIINGO_DROP_NEWS` (3→2 calls/symbol) and negative-caches no-data symbols; `__resetTwelveDataWindowForTests`
  kept as a shim delegating to `resetProviderQuotaState`. **Finnhub reverted to pacer-only**
  (an earlier draft quota-gated it, which over-restricted a per-symbol provider and broke the
  starvation-regression tests — the correct control for finnhub is the pacer).
- `test/provider-rate-limit.test.ts` — `resolveProviderQuota` (built-ins + env replace/remove/add)
  and `RequestQuota` (tightest-window cap, multi-window min, per-credential isolation, sliding
  refill, unlimited passthrough, non-positive, `reset`) unit tests via the existing `FakeClock`.
- `test/data-providers.test.ts` — Twelve Data tests migrated to `PROVIDER_QUOTA_TWELVEDATA_PER_MIN`;
  new Tiingo tests (hourly-cap budget is scan-size-agnostic; `TIINGO_DROP_NEWS` frees budget).

## Verification

Run under node@24 (the Mac's default `node` is v26, whose ABI mass-fails better-sqlite3 — see
the [Mac node26 ABI trap] memory):

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run lint       # 0 errors (373 grandfathered warnings)
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit   # clean except stale .next/types (app/design/socratic-trade/page — untouched; regenerated by build)
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run build      # success (exit 0; in-build TS check clean, 28/28 static pages)
```

Targeted, all green:
- `npx vitest run test/provider-rate-limit.test.ts` → 40 passed
- `npx vitest run test/data-providers.test.ts` → 93 passed (incl. the 2 new Tiingo tests + migrated Twelve Data)

**Node ABI trap (this worktree):** the Mac's default `node` is v26 (homebrew changed the default
2026-07-10) and this worktree's `better-sqlite3` had been rebuilt against node26 (ABI 147). Running
gates under node@24 (ABI 137) initially mass-failed with `NODE_MODULE_VERSION` errors; fixed with
`PATH=/opt/homebrew/opt/node@24/bin npm rebuild better-sqlite3`, after which better-sqlite3 loads
under node24. **Run every gate with `/opt/homebrew/opt/node@24/bin` on PATH.**

**Full-suite flakiness is environmental, not this change.** The full *parallel* suite on this shared
machine produced a VARYING set of failures run-to-run (6, then 37) dominated by `Test timed out in
20000ms` / hook timeouts and intentional simulated-outage tests (Pinecone 503, Alpaca MCP 500,
"simulated broker cancel") — the signature of CPU/IO contention (repeated full runs + the launchd
disk-janitor reaping `agentic-*` temp SQLite DBs + sibling sessions), not a deterministic bug. Proof:
all 9 flagged files (data-providers, red-team, redteam-failure-routing, strategy-bear-fail-closed,
strategy-bull-truncation, security-oauth-token-encryption, broker-protective-stops, rag-retrieval-status,
vector-db-backlog-c-integration) pass **197/197 when run in isolation** (`--no-file-parallelism`). None
of them except data-providers even touches provider rate-limiting, and the data-providers failure was a
FintechStudios (non-quota'd) 500-handling test. The GitHub `verify` CI runs in a clean env and is the
authoritative gate.

PR: #1310 (auto-merge armed on `verify`).

## Follow-ups / notes

- **Verify AV + Twelve Data + Tiingo go green on the next pre-market scan** (~08:00 UTC). The
  overnight market was closed, so the cascade hadn't reached these providers since the last deploy.
- **Owner action (agents blocked):** whitelist the new prod box IP `<HETZNER_OLD_IP_RETIRED>` on the
  **congress.trade** Cloudflare zone — the box IP isn't whitelisted, so congress.trade 403s.
- Alpha Vantage's per-minute cap is already handled by its serial ~1.1s pacer + the key pool's
  per-key 25/day exhaustion memory, so it is intentionally not double-gated by the quota.
</content>
</invoke>
