# Rollout — Guard enablement (2026-07-28, KIMI)

## Context & Objective

Implement the owner-approved guard enablement from `docs/guard-enablement-proposal-2026-07-28.md`
(rows 1, 2, 3+4, 8): turn on four default-off guards that bound mechanical failure and improve
crisis awareness without seizing control from the agent, plus write the trigger-engine transition
plan (proposal row 11). Philosophy preserved: the only new hard block is "don't open on stale
quotes" (self-healing via human approval against a fresh scan); everything else is tapers,
information, or notification. Exits are untouched everywhere.

## Changes Made

**New defaults (`src/lib/defaults.ts`)**
- `DEFAULT_POLICY.maxQuoteAgeSec: 120` — quote staleness gate (policy.ts:393-415, pre-existing):
  blocks OPENING orders on quotes older than 120s or with missing/unparseable timestamps; exits
  never gated; escalatable (approval re-runs against a fresh scan → self-heals).
- `DEFAULT_POLICY.tuning` (NEW object — previously undefined): `riskReceipts: true`,
  `volTargeting: true`, `targetPortfolioVolPct: 25`, `portfolioHeatBudgetPct: 10`.
  `skipNegativeExpectancy` / `fractionalKellySizing` / `earningsBlackout` deliberately left off.
- `DEFAULT_RISK_RULES.maxDrawdownPct: 15` — advisory drawdown breaker;
  `drawdownBreakerAction` stays unset (= advisory).

**Tuning deep-merge (both `mergePolicy` copies, kept identical)**
- `src/lib/db.ts` (migrate-time copy, ~line 3827) and `src/lib/db-profiles.ts` (runtime copy,
  ~line 255): added `tuning: { ...DEFAULT_POLICY.tuning, ...(policy.tuning ?? {}) }` next to the
  existing `riskRules` deep-merge, so stored policies inherit the new default tuning keys while
  any explicit per-account key wins. Side effect: every merged policy now always HAS a `tuning`
  object (with the four keys). No test asserted tuning-absence on merged policies (the
  deep-equality concern in the task brief did not materialize — `policy-normalization`,
  `settings-import`, `policy-default-universe` all pass unchanged).

**Advisory drawdown-breaker breach notification (`src/lib/strategy.ts`, advisory branch ~line 671)**
- Advisory mode previously wrote only an audit row + prompt context. It now also calls
  `sendNotification`, deduped to at most once per (userId, accountNumber, source, day) via
  internal-settings marker `risk:dd-advisory-notified:{userId}:{accountNumber}:{source}:{day}`
  (same KV pattern as risk-breaker.ts's hwm/sod keys). First breach of the day notifies;
  subsequent breaching runs still write the audit receipt + prompt context but do not re-notify.
- Event type: **NEW union member `risk_advisory`** (see Decisions). Title:
  `Drawdown advisory: <reason> (agent still in control)`. `sendNotification` applies the user's
  `enabledEvents` gating (notifications.ts:146) — verified in code; `risk_advisory` is on by
  default via `DEFAULT_NOTIFICATION_SETTINGS` (spread of `NOTIFICATION_EVENT_TYPES`).
- Supporting surfaces for the new event type: `src/lib/types.ts` (union),
  `src/lib/dashboard-ui.ts` (`NOTIFICATION_EVENT_TYPE_LABELS` — full Record, compile-enforced),
  `app/console/settings/page.tsx` (`EVENT_HINT` — full Record, compile-enforced),
  `src/lib/db-notifications.ts` (`ATTENTION_TYPES`) + `app/console/components/alert-center.tsx`
  (`matchesFilter`) so advisories land in the Alert Center's Attention pill (kept in sync per the
  in-code comment). NOT added to `src/lib/mobile-api.ts`'s explicit allowed list — mobile push
  won't carry it (noted as limitation).

**Tests**
- New `test/guard-enablement.test.ts` (5 tests): tuning deep-merge precedence for db-profiles
  `mergePolicy` (explicit key wins, missing key inherits; `maxQuoteAgeSec: 0` explicit-off
  survives; riskRules default 15 inherited / explicit wins / action stays advisory); advisory
  breaker notification fires once per day across TWO real `runStrategyOnce` runs and not again,
  while the audit receipt still fires per run.
- `test/staleness-gate.test.ts`: two gate-OFF tests pin `maxQuoteAgeSec: 0` (they test the off
  code path); NEW describe block for the DEFAULT 120s gate (300s-old quote blocked, 10s quote
  allowed, exact-120s boundary allowed, sell never gated).
- Fallout fixes pinning old values in unrelated fixtures (no assertions weakened):
  `test/risk-receipts.test.ts` (pin `tuning: { riskReceipts: false }` in the two flag-OFF tests),
  `test/policy.test.ts` + `test/pdt.test.ts` + `test/strategy-hardening.test.ts` +
  `test/washsale-modes.test.ts` (pin `maxQuoteAgeSec: 0` — these call `evaluateTradeProposal`
  with no marketScan / no asOf timestamps, and a missing timestamp now blocks openings),
  `test/strategy-moneypath-drawdown-flip.test.ts` (pin `riskRules: { maxDrawdownPct: 0 }` in the
  "no limit configured" test — a bare `{}` now inherits the 15% default via mergePolicy).

**Docs**
- `docs/event-driven-transition-plan.md` (NEW): verified trigger-engine architecture, staged
  enablement path (Stage 1 `TRIGGER_ENGINE=1` + `TRIGGER_MODE=both` via Infisical; Stage 2
  `TRIGGER_MODE=event`), monitoring plan, gaps (G1: no fallback interval in event mode — code gap,
  scheduler.ts:744-748 skips the cadence lane entirely; G2: event-triggered runs are FULL
  `runStrategyOnce` runs — "close-only review run on regime flip" is UNIMPLEMENTED, listed as a
  follow-up), open questions for the owner.
- `STATUS.md` (new dated entry), `docs/EFFORT-LOG.md` (KIMI row → implemented/verified).

## Decisions & Trade-offs

- **New notification type `risk_advisory` instead of reusing an existing one.** The brief asked
  for the closest existing union member, but none fits: `kill_switch` is wrong (nothing halted —
  reusing it would train the owner to ignore kill-switch alerts), `block` is wrong (nothing was
  blocked; its body formatter reads `decision.reasons`), `budget_alert` is wrong (its formatter
  renders provider-usage copy). The brief allowed a new member when clearly warranted. Cost was
  small and compile-enforced: the two UI label maps are full `Record<NotificationEventType, …>`
  so tsc forced every copy site to be updated. Settings toggles pick it up automatically (they
  enumerate `NOTIFICATION_EVENT_TYPES`).
- **Dedup marker set BEFORE `sendNotification`**: even if delivery fails, no same-day retry spam;
  the failed delivery is still recorded in `notification_events` for the Alert Center.
- **Scope discipline**: per the approved proposal, Kelly sizing, negative-expectancy skip,
  correlation cluster gate, and earnings blackout stay OFF. `drawdownBreakerAction` stays unset
  (advisory) — no enforcement mode.
- **Staleness-gate impact assumption — VERIFIED, with one documented caveat.** Opening proposals
  come from scan `topCandidates`, and every topCandidate symbol is passed through
  `gateway.getEquityQuotes` and merged via `mergeQuoteData` (strategy.ts:616) BEFORE decisions:
  - Alpaca (`alpaca.ts:430-481`): `asOf` = the exchange quote timestamp `t` from `getLatestQuotes`
    — typically seconds old for liquid names during market hours. The ~30s Alpaca snapshot cache
    TTL (`data-providers.ts:455`) only bounds reuse, keeping quotes <~60s old. So in the normal
    path the 120s gate does NOT bind.
  - Robinhood (`robinhood.ts:355-392`): `asOf` = `venue_last_trade_time` — also a real venue
    timestamp.
  - **Caveat (documented, accepted)**: three degradation paths produce old timestamps that the
    gate will (correctly) block on: (a) Alpaca's keyless fallback `fillMissingQuotesWithClose`
    stamps the last DAILY-CLOSE bar time as `asOf` — hours old — for symbols the broker left
    unpriced (common outside market hours / free IEX tier); (b) symbols the gateway fails to
    price keep the NASDAQ screener `asOf`, which is ~15-min delayed (market.ts:901, screener
    rows are marked `stale: true`); (c) genuinely quiet names can have venue timestamps minutes
    old even in real-time feeds. In all three the block is escalatable — human approval re-runs
    the gate against a fresh scan — which is exactly the designed self-healing behavior, not a
    silent failure. Net: 120s only binds on provider degradation or off-hours fallback data for
    the default S&P-500 universe. Good to ship as approved.
- **`TRIGGER_MODE=event` has no fallback interval** — verified in scheduler.ts:744-748 and flagged
  as gap G1 in the transition doc rather than "fixed" here (out of scope).

## Verification State

Commands run (in the required order), all on branch `agent/kimi/guard-enablement`:

```
npx tsc --noEmit   # PASS (after adding risk_advisory labels to the two compile-enforced UI maps)
npm run lint       # PASS — 0 errors, 652 warnings (grandfathered backlog, unchanged in kind)
npm test           # PASS — full suite: 461 files / 5,358 tests, 0 failed, 0 skipped
npm run build      # PASS — full Next.js build
```

Note: `npm test` runs serially (`maxWorkers: 1` in vitest.config.ts) and exceeds any single
5-minute shell window, so the suite was executed as six alphabetical file-list chunks
(`npx vitest run $(cat /tmp/chunk-aX)`), each re-run to green after fixture fixes; totals above
are the sum (877+963+940+991+634+953). The pre-existing
`test/alternative-data.test.ts` `mockFetcher` type note did not appear (tsc clean).

### Adversarial-verifier findings + fixes (second commit)

- **F1 (HIGH) — `risk_advisory` would never deliver on push channels for existing accounts.**
  Chain: `notifications.ts:146` drops types not in the stored `enabledEvents`; `mergePolicy` lets
  the stored list win wholesale; so every account that ever saved settings had a frozen list
  without `risk_advisory`, and no migration unions new types. Fixed at the send site in
  `strategy.ts` using the repo's established precedent (`provider_degraded` in db-health.ts,
  `budget_alert` in usage-limit-alerts.ts, `autonomy_halted_on_boot` in scheduler.ts): the send
  builds a run-scoped `forcedAdvisoryPolicy` with `risk_advisory` unioned into the EFFECTIVE
  `enabledEvents` for that send only — the user's stored list is never mutated or persisted.
- **F3 (LOW) — marker-before-send.** The dedup marker was written BEFORE `sendNotification`;
  a skipped/failed send would have burned the day's one notification. The marker is now written
  AFTER the send resolves (channel errors are caught inside `sendNotification`, so resolution =
  accepted-for-delivery).
- **F4 (LOW) — alert-center tone.** `risk_advisory` now renders `warn` like its Attention-pill
  peers (was `muted`).
- **F5 (LOW) — body formatters.** Added a dedicated `risk_advisory` case to BOTH
  `directNotificationBody` (SMS/push body: reason + drawdownPct + equity + HWM + explicit
  "advisory only" line) and the Discord embed switch (orange — kill_switch stays red — with
  drawdown/equity/HWM/runId fields).
- **Regression test** (`test/guard-enablement.test.ts`): stored policy with an explicit
  `enabledEvents: ["fill", "block"]` (predating `risk_advisory`) breaches the breaker → the
  notification is recorded and ATTEMPTED (error is NOT "Notification type is disabled."), proving
  the force-inject works. The existing once-per-day dedup test still passes.

Re-verification after the fixes: `npx tsc --noEmit` PASS; `npm run lint` PASS (0 errors, same 652
warnings); `test/guard-enablement.test.ts` (6 tests incl. the new regression) + 12 targeted
notification/strategy files (247 tests) + an 877-test broad sanity chunk — all PASS. Full-suite
re-run skipped per judgment allowance (fixes confined to strategy.ts send site, alert-center tone,
notifications formatting).

### Deploy-day watch items (owner)

1. **Immediate breaches**: any account already >15% below its persisted equity high-water mark
   breaches the moment this deploys — expect an advisory receipt + prompt injection EVERY run plus
   exactly 1 `risk_advisory` notification per account/day. That's the design working, not a bug;
   re-mark the HWM (or relax the threshold) if it's stale from an old equity peak.
2. **Smaller openings in volatile names**: the vol-target (25%) and heat (10%) tapers now scale
   down opening sizes in wild names / hot books. Watch rationales for the `[Risk]`/vol/heat notes
   to confirm tapers bind where expected.
3. **Possible `quote_staleness` escalation burst**: the 120s gate measures scan→evaluation latency
   against the merged quote timestamp. If real scan→LLM→evaluation latency plus provider delay
   exceeds 120s for routine names, openings will route to human review in bursts. Fail-safe and
   self-healing (approval re-runs against a fresh scan) but noisy — observe real latency before
   loosening the threshold.

## Next Steps & Blockers

- Parent agent lands via `scripts/land.sh` (commit is local-only per instructions; no push/PR
  from this session). Reminder for landing: mirror the KIMI row into the branch-neutral live
  board `/Users/jay/apps/TRADING-EFFORT-LOG.md` (repo mirror `docs/EFFORT-LOG.md` is updated here).
- After deploy: confirm the first `risk_advisory` notification renders correctly in the Alert
  Center (labels added to dashboard-ui + alert-center Attention filter; mobile-api push list
  deliberately not extended).
- Owner decisions queued in `docs/event-driven-transition-plan.md`: Stage-1 duration, G1 fallback
  interval vs alert-only, G2 close-only regime-flip run (unimplemented follow-up), Stage-1
  `TRIGGER_LLM_DAILY_TOKEN_BUDGET` value, initial cap levels.
- Watch the staleness gate in production for the caveat cases above (Alpaca daily-close fallback,
  screener-delayed asOf): if routine symbols get blocked off-hours, the answer is escalation
  (self-healing), not raising the threshold — unless evidence shows otherwise.
