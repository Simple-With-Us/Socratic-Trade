# 2026-08-13 — Pickup Monet + Claude quota-cap

## 1. Context & Objective

Owner: take over every in-flight Monet/Claude task from today's chats after both seats
hit the session limit (resets 7pm America/Chicago).  Prior message stays in scope: GOOG
Key Stats dashes plus tappable fill/position cards.

## 2. Changes Made

Inventory-only at orchestration time; implementation is in sibling agent lanes.

- Claimed on live boards (`TRADING-EFFORT-LOG.md`, `CONGRESS-TRADE-EFFORT-LOG.md`,
  `API-USAGE-MONITOR-EFFORT-LOG.md`) and `#ag***-s**c`.
- Spawned a six-lane team (plus one audit-hygiene explorer).

**Already merged today — not re-done:**

| PR | What | Seat |
|---|---|---|
| ST #2684 | Honest server stats | Monet |
| ST #2682 | Real toggles / force-include removal | Monet |
| ST #2681 | APNs native push | Monet |
| ST #2680 | Adaptive FTS-mirror yield | Claude |
| ST #2667 | Load screens + Lato | Monet |
| ST #2662 | iOS order cancel / waves 2-3 | Monet |
| ST #2666 | r3 scorecard / lookahead / PIT / Polymarket | Claude |
| CT #1835 | Premium one-screen + inline IAP redeem | Claude |
| CT #1837 / #1839 | CI ship trigger / backstop | Monet |

**Picked up (in flight):**

1. Unstick ST #2685 + #2683 (GitHub CONFLICTING/DIRTY; `merge-tree --write-tree` exit 0 = phantom).
2. Land leftover `monet/ship-pipeline-fix` (3 commits, no PR).
3. Land unpushed Claude r4 (`1ac172a9`..`40d5c087`; origin/agent/claude gone).
4. Quote Key Stats dashes + tappable fill/position cards (`grok/quote-stats-and-card-taps`).
5. r4/r5 residue after Monet's backend chat (do not collide with r4 pickup).
6. CT/UM leftovers: hide stay-funded for LLM accounts; add CF accounts to UM.
7. Audit-session hygiene: leftover findings vs issues/board.

## 3. Decisions & Trade-offs

- Work from existing Monet PR worktrees for unstick/land of their branches; new Grok
  worktrees for everything else so Monet/Claude can reclaim their lanes.
- Dual credit `Co-Authored-By: Claude <noreply@anthropic.com>` on adopted commits.
- No new provider API keys (fleet rule).  Reddit/X stay owner-blocked.

## 4. Verification State

Pickup inventory + closeout:

```
gh pr list --state open
git merge-tree --write-tree origin/main origin/monet/compaction-visibility   # exit 0
git merge-tree --write-tree origin/main origin/monet/durable-inventory-cache # exit 0
AGENT_TAG=GROK /usr/bin/python3 /Users/jay/apps/ag***-s**c-poll.py
```

Lane gates (each ran `scripts/land.sh` locally):

| Lane | PR | Local gate | Disposition |
|---|---|---|---|
| Unstick compaction | #2685 | merge-tree 0 | **MERGED** 23:01Z |
| Unstick inventory | #2683 | merge-tree 0 | OPEN, MERGEABLE, auto-merge, verify-hosted in progress |
| Ship pipeline | #2687 | 6600 pass / 51 skip | OPEN, MERGEABLE, auto-merge (re-pushed after #2685) |
| Claude r4 | #2689 | 6651 pass / 51 skip | OPEN, MERGEABLE, auto-merge |
| Quote + cards | #2692 | 6624 pass / 51 skip | OPEN, MERGEABLE, auto-merge |
| r5 residue | #2691 | 6612 pass / 51 skip | OPEN, auto-merge (re-pushed after #2685) |
| Duplicate quote | #2690 | — | **CLOSED** as duplicate of #2692 |
| UM stay-funded + Old CF | UM #1168 | land.sh | **MERGED** |
| CT iOS leftovers docs | CT #1840 | land.sh | **MERGED** |

## 5. Next Steps & Blockers

- Remaining ST PRs merge when required `verify` goes green (auto-merge already armed).
- After #2692 deploys, reopen GOOG on iOS: 52W should fill from chart immediately; PE/EPS/div/beta from quoteSummary or `symbol_field_latest`.  Native card-tap UI ships on the next TestFlight.
- Returning Monet/Claude: cede these lanes until they re-claim.
- Owner-parked: Reddit/X keys; flip `VECTOR_ASOF_STRICT` only after a fresh RAG-coverage receipt; Litestream L2 wedge is still ops work.

## 6. Zero-Code Findings

### Why GOOG Key Stats are dashes (and why data looks unsaved)

The iOS sheet (`SymbolInfoSheet`) calls `GET /api/quote`.  That route:

1. Uses Yahoo **chart** (`/v8/finance/chart/{symbol}`) as the fast floor.  Chart meta is
   price, volume, name, prevClose, time only.  It never maps 52-week, PE, EPS, yield, or
   beta — even though Yahoo's **quote** endpoint (`/v7/finance/quote`, used only for
   batch) can return those fields, and this codebase does not parse them there either.
2. Runs the full enrichment cascade with a **6 second** budget.  Timeout keeps the Yahoo
   floor and still returns 200.  The screenshot (price + volume + name + change, everything
   else "—", "live fetch" footer) is exactly that shape.
3. Does **not** read `symbol_field_latest`.  Fundamentals saved by a prior scan never
   appear on this sheet.  If the cascade times out, this path also writes nothing back,
   so the next open is the same dashes.

"Not updated" is the same seam: FMP is retired/off, the interactive sheet does not reuse
the durable store, and a slow cascade is discarded after 6s instead of seeding from last
known good fields.

Card taps: only `SymbolTapButton` (logo + ticker) presents the sheet.  The rest of
`PositionRow` / fill rows is inert.

Lane 4 is fixing both.
