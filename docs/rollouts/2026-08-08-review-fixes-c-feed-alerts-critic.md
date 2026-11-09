# 2026-08-08 — Review-fix wave C: activity feed, alert center, critic visibility (MONET)

Branch `monet/review-fixes-c`. Issues **#2553** (feed signal-to-noise), **#2555** (alert-center
fatigue), **#2552** (critic failures under-surfaced). Source review:
`docs/reviews/2026-08-06-claude-full-product-review.md` §C5/C7/C8/D3.

## 1. Context & Objective

Three compounding console problems from the 2026-08-06 live review: (a) the activity feed opened
with ~30 ingest/embed cards and duplicate "BUY T"/"TRADE T" sibling rows per action; (b) the alert
center's Attention list was mostly provider_degraded repeats burying real items, with no way to
silence a known-degraded lane; (c) failed Red Team reviews rendered as a cause-less "AI critic:
failed" chip with no aggregate failure-rate anywhere.

## 2. Changes Made

### #2553 — activity feed

- **(a) Ingest/embed kinds route into the System collapse.** `OPS_AUDIT_KINDS`
  (`src/lib/dashboard-feed.ts`) now includes `sec_filing_ingest`, `sec_filing_refresh`,
  `disclosure_rag_embed`, `fmp_transcript_ingest`, `fmp_transcript_refresh`,
  `roic_transcript_ingested`, `roic_transcript_refresh`, `technical_signal_ingest`,
  `fundamentals_card_ingest`, `sec8k_rag_backlog_truncated`. None carry runId/proposalId, so each
  was a standalone TODAY card; the console's existing `isOpsGroup` collapse picks the set up
  unchanged.
- **(b) "BUY X"+"TRADE X" duplicate rows folded at derive time.** Root cause identified: the
  strategy loop (`src/lib/strategy.ts`) generates a working proposalId up front, emits pre-insert
  receipts against it (`quote_staleness_warn` audit + the stale-quote `provider_degraded`
  notification), then **regenerates the id** just before persisting in several branches — so the
  receipts' id never lands in `trade_proposals` and one action rendered as the persisted sided
  group ("BUY T") plus a side-less orphan group ("TRADE T"). `buildUnifiedFeed` now tracks a
  per-group runId and, when a prop group's proposalId does NOT resolve via `getProposalById`,
  folds its events into the resolved prop group for the same run + symbol. Both receipts survive
  as sub-events of the one merged row (expandable detail). Orphans holding fill/order events are
  never folded (real money receipts); cross-run orphans and no-resolver inputs stay untouched.
- **(c) No-op `disclosure_rag_embed` audits suppressed at source.**
  `src/lib/web-sources/disclosure-rag.ts`: when a cycle is a pure no-op (indexed=0, not skipped,
  no error — i.e. every doc content-hash-deduped before embedding), the per-cycle audit row is
  suppressed; cycles accumulate in an internal-settings watermark
  (`disclosureRag:noopRollup`) and flush as at most ONE daily rollup row
  (`{ rollup: true, dedupedCycles, dedupedAttempted }`). Indexed/skipped/error cycles still audit
  every time. The audit write is now awaited (still swallowed on failure) so behavior is
  deterministic for callers/tests.

### #2555 — alert center

- **(a) Provider-outage rollup.** All visible `provider_degraded` incident rows collapse into ONE
  expandable "N provider lanes degraded" `<details>` row at the top of the list
  (`app/console/components/alert-center.tsx`, new pure `partitionProviderRollup`); per-lane rows
  (with their x-repeat counts, ack and mute buttons) render inside the expansion.
- **(b) Per-condition 24h mute.** New pure module `src/lib/alert-mutes.ts`
  (`alertConditionKey` = (type, account, title); `activeAlertMutes`/`isAlertMuted` expiry logic),
  persistence in `src/lib/db-settings.ts` (`getAlertMutes`/`setAlertMute`, user_settings KV key
  `alertConditionMutes`, expired entries pruned on write), API
  `app/api/notifications/mute/route.ts` (GET active mutes / POST `{ key, mute }`), client helpers
  in `app/console/lib/api.ts`. Each alert row gets a BellOff mute button; muted rows leave the
  list (and the pill counts) but stay one click away behind a visible "muted N — show" toggle
  with per-row Unmute. Advisory by construction: rendering-only, delivery untouched, reversible,
  auto-expires after 24h.

### #2552 — critic visibility

- **Chip carries the CAUSE.** `redTeamSummaryChip` (`app/console/components/approval-card.tsx`)
  now renders a failed review as `AI critic failed — <model>: <kind>` (e.g. "AI critic failed —
  DeepSeek Chat: malformed response"), warn tone, honest attribution via the existing
  `redTeamFailureModel` (never blames a model that provably never ran);
  `failureKind === "not_configured"` gets a distinct muted "AI critic: not configured" chip.
  The console thesis drawer (`app/console/page.tsx` ThesisSection) adds a
  "Red Team failed — <model> (<kind>)" line under the verdict chip, matching the PWA's honesty.
- **Critic failure rate (30d) stat.** New `getRedTeamCriticFailureStats`
  (`src/lib/db-proposals.ts`): failures/attempted reviews over the user's proposals' persisted
  `redTeamVerdict` fields (user-wide — a model/config condition), with per-kind counts and the
  top (model, kind) attribution. Wired through `getDashboardRedTeamEfficacy`
  (`src/lib/dashboard.ts` → `redTeamEfficacy.criticFailure`, typed in
  `app/dashboard-types.ts`) and rendered as a stat in the Results "Red Team veto efficacy" card
  (`app/console/results/page.tsx`) — including in the zero-veto empty state, so a failing critic
  is never hidden behind an empty veto history.

### Files touched

- `src/lib/dashboard-feed.ts` — ops kinds + orphan prop-group fold (runId tracking)
- `src/lib/web-sources/disclosure-rag.ts` — no-op audit rollup (`DISCLOSURE_RAG_NOOP_ROLLUP_KEY`)
- `src/lib/alert-mutes.ts` — NEW pure mute helpers
- `src/lib/db-settings.ts` — `getAlertMutes`/`setAlertMute`
- `src/lib/db-proposals.ts` — `getRedTeamCriticFailureStats`
- `src/lib/dashboard.ts` — criticFailure wiring
- `app/dashboard-types.ts` — criticFailure type
- `app/api/notifications/mute/route.ts` — NEW mute API
- `app/console/lib/api.ts` — `fetchAlertMutes`/`setAlertConditionMute`
- `app/console/components/alert-center.tsx` — rollup, mutes, AlertRow extraction
- `app/console/components/approval-card.tsx` — failure-cause chip
- `app/console/page.tsx` — drawer failure-cause line
- `app/console/results/page.tsx` — CriticFailureStat
- `test/dashboard-feed.test.ts`, `test/disclosure-rag.test.ts`, `test/alert-mutes.test.ts` (NEW),
  `test/red-team-critic-failure-stats.test.ts` (NEW), `test/approvals-triage-model.test.ts`

## 3. Decisions & Trade-offs

- **#2553b fixed at DERIVE time, not in strategy.ts.** The id-regeneration sites are money-path
  branches; per the task spec the merge happens in `buildUnifiedFeed`, keyed on
  (runId, symbol) and gated on "proposalId does not resolve" + "no fill/order events" so a real
  proposal can never be swallowed. Cross-run orphans deliberately stay standalone.
- **Mute fingerprint = (type, account, title)** — same parts as the incident-grouping key minus
  ack state, so a mute covers both open and acked repeats of one condition. Muting a condition
  whose producer changes its title (e.g. new error text) creates a new condition — accepted; the
  mute is a 24h convenience, not a routing rule.
- **Rollup renders whenever ≥1 provider_degraded row is visible** (not only ≥2) for stable,
  predictable layout; it applies across filters (a provider row matching Deliveries also rolls
  up there).
- **Critic failure rate is user-wide, 30d, denominator = proposals CARRYING a verdict.**
  Proposals below every review trigger are excluded — they are not failures. Account scoping was
  deliberately not applied (model/config condition, and the stat's tooltip says so).
- **not_configured is muted, not warn** — distinct from real failures per the issue ("visually
  distinct"); the legacy-unavailable and no-review chips are unchanged.
- **Cross-account severity counts in the "hidden by account scope" banner (issue #2555 item 3)
  deliberately NOT implemented** — out of the assigned (a)/(b) scope; left for a follow-up.
- No new dependencies.

## 4. Verification State

```bash
npx tsc --noEmit                     # clean
npx vitest run test/dashboard-feed.test.ts test/disclosure-rag.test.ts \
  test/alert-mutes.test.ts test/approvals-triage-model.test.ts \
  test/red-team-critic-failure-stats.test.ts test/alert-center-incident-grouping.test.ts \
  test/notification-lifecycle.test.ts # 7 files, 107 tests, all passed
npx vitest run test/dashboard-agentic-fallback.test.ts test/dashboard-fill-batching.test.ts \
  test/dashboard-smart-money-slice.test.ts test/dashboard-snapshot-cache.test.ts \
  test/dashboard-ui.test.ts test/console-sheet.test.tsx test/audit-hygiene.test.ts
                                     # 7 files, 36 tests, all passed
npm run lint                         # 0 errors (728 grandfathered warnings)
```

Full `npm test` + `npm run build` deferred to the landing operator per the wave workflow.

## 5. Next Steps & Blockers

- Landing operator: full gate (lint → tsc → npm test → build), push, PR referencing
  #2553/#2555/#2552, auto-merge.
- Follow-up candidates: per-account severity counts in the hidden-alerts banner (#2555 item 3);
  fixing the pre-insert proposalId regeneration in `strategy.ts` at the source (would make the
  derive-time fold a pure safety net); surfacing `criticFailure.byKind` as a breakdown table if
  the single stat proves too coarse.

## 6. Zero-Code Findings

- The "BUY T"/"TRADE T" duplicate mechanism (pre-insert id regenerated at
  `src/lib/strategy.ts:3580/3621/3659/3680` after receipts were emitted against the initial id
  from line 3286) was verified by code-trace; it also explains "SELL ZTS appears twice at the
  same age" when one of the pair is receipt-only.
