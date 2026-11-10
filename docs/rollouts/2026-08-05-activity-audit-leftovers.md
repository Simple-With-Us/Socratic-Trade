# 2026-08-05 — Activity-audit leftovers (P2.4 + P3 verification)

## Context & Objective

Close out the activity-feed audit leftovers claim (`grok/activity-audit-leftovers`): verify which §1.4 / §1 P3 items from `docs/reviews/2026-07-09-activity-feed-audit.md` already landed on `main`, mark the effort board accurately, and land only tiny residual polish that does not fight sibling agents on `strategy.ts` / `db-fills`.

Multi-agent branch: siblings own fill flip (P3.5) and evidence_age key (P3.8). This pass is board hygiene + optional polish.

## Changes Made

### Verification findings (already on main / already shipped)

| Item | Status | Evidence |
|------|--------|----------|
| **P2.4** congress_share retry storm (code) | **COMPLETED + DEPLOYED** via **PR #1492** (2026-07-13) | `activeDailySharePromise` single-flight; `isCongressDailyShareDue` 60m `congress_share_last_failure_ms` backoff in `src/lib/congress-share.ts`. OPS CF whitelist for old Hetzner IP is historical (prod on Oracle). |
| **P2 backlog** §1.5–1.9 | **COMPLETED + DEPLOYED** | P2.5 #1451; P2.6 #2459/#1319; P2.7+P2.8 **#2489** / #1320/#1321; P2.9 already on main (#1322 closed; seeding still #1324). |
| **P3.1** feed-storm coalesce | **On main** | `buildUnifiedFeed` consecutive-group coalesce in `src/lib/dashboard-feed.ts`. |
| **P3.2** AAPL trim cap-vs-floor | **On main** | Bump-to-floor / dollar-sell path via **#1297** (`broker-minimum-guard.ts`). |
| **P3.3** `policy_change` attribution | **On main** | `setPolicy` / `setStrategyPrompt` pass `account.id` in `src/lib/db-profiles.ts`. |
| **P3.4** broker-protective-stops attribution | **Mostly on main** | Nearly all `audit()` sites already pass `policy.connectedAccountId`; leftover `bracket_sibling_*` fixed this pass. |
| **P3.6** storage_warning mislabel | **On main** | `storage_warning` in `types.ts` + notify/audit path in `db-health.ts`. |
| **P3.7** KNOWN_GLOBAL footer | **On main** | `KNOWN_GLOBAL_AUDIT_KINDS` → "System-wide" in `dashboard-feed.ts`. |

### Sibling / residual code on this branch (not this docs commit's ownership)

| Item | Notes |
|------|--------|
| **P3.5** stuck `'undefined'` `fill_events` → `unreconcilable` | **Committed on branch** as `66716e99` (`fix(fills): terminal unreconcilable…`) — migration v67, list exclusion, forward guard, UI chip, tests. |
| **P3.8** `evidence_age_anomaly` first-sight per `(id, assertedAt)` | **Committed on branch** as `629eacdd` (`fix(strategy): first-sight evidence_age_anomaly…`) — `(id, assertedAt)` key + LRU eviction; helpers + unit tests. |
| **#1324** owner decisions (4) | Stay **PLANNED / needs owner** (test-local autonomy, RAG 10-K pacing, `llmFallbackModels` seed vs UI, learned_context isolation). |

### Code polish this pass (board-hygiene agent)

- `src/lib/broker-protective-stops.ts` — optional `connectedAccountId` on `reconcilePendingBracketTeardowns`; threaded into `bracket_sibling_legs_torn_down` / `bracket_sibling_teardown_abandoned`.
- `src/lib/synthetic-stops.ts` — pass `policy.connectedAccountId` into that reconcile call.
- `test/congress-share.test.ts` — unit coverage for the 60-minute failure backoff on `isCongressDailyShareDue`.

### Docs / board

- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — P2.4, P2 backlog, P3 1–4/6–7 marked done; leftovers claim completed for hygiene+polish scope; #1324 kept Planned.
- This rollout note.

## Decisions & Trade-offs

- Did **not** edit `strategy.ts` or `db-fills` here (owner instruction + sibling ownership).
- Did **not** push/PR this commit (owner: commit only).
- OPS half of original P2.4 (CF whitelist of Hetzner `135.181…`) is obsolete after Oracle migration; code half is the durable fix.

## Verification State

```bash
# focused (this polish)
npx vitest run test/congress-share.test.ts -t "isCongressDailyShareDue"
# optional broader
npx vitest run test/congress-share.test.ts test/broker-protective-stops.test.ts
```

## Next Steps & Blockers

1. Land branch via `scripts/land.sh` when ready (P3.5+P3.8 already committed on branch).
2. Owner: decide #1324 items when ready.
3. Do not push/PR from this docs pass alone.

## Zero-Code Findings

Most of the "leftovers" claim was **already shipped** on `main`; the primary work for the board-hygiene agent was accurate board hygiene so parallel agents stop re-implementing closed audit items.

---

# P3 item 8 — evidence_age_anomaly first-sight dedupe (GROK sibling; committed `629eacdd`)

## Context & Objective

`evidence_age_anomaly` echoed the same facts across runs (audit: 120 rows / 214 flagged items over
only 10 distinct evidence ids). Dedupe was id-only with a **6h TTL** and bulk `Map.clear()` at
size >1000. Goal: first-sight per **(fact id, assertedAt)**; true-ish LRU eviction.

## Changes (sibling commit `629eacdd` — not part of the docs: polish commit)

- Dedup key: `` `${userId}:${connectedAccountId ?? "global"}:${id}:${assertedAt ?? ""}` ``
- Once seen for that key, never re-emit until LRU eviction (removed 6h TTL re-fire).
- When cache size would exceed 1000, delete oldest Map keys (insertion order) instead of `clear()`.
- Pure helpers: `evidenceAgeAnomalyDedupKey`, `rememberEvidenceAgeAnomalyDedupKey`.
- Files: `src/lib/strategy.ts`, `test/evidence-age-anomaly-dedup.test.ts`.

## Verification (when sibling commits)

```bash
npx vitest run test/evidence-age-anomaly-dedup.test.ts test/strategy-prompt-safety.test.ts test/prompt-safety.test.ts
```
