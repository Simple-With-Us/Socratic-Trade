# 2026-10-14 Tradier sandbox open HTTP 400

## Context & Objective

Tradier Sandbox answered the order path with HTTP 400 and the sentence "Unexpected server error" around the cash open (2026-10-13 5:41, 8:35, and 8:43am CT; 2026-10-14 8:35 and 8:47am CT).  The preview probe classified that as "order path unavailable", which is an immediate auto-halt, and the next healthy probe auto-resumed.  Those ticks also wrote `skipped_broker_unhealthy`.  The sentence is a wedged sandbox OMS.  It must retry with backoff and must not flip `systemState`.  Real rejections still fail on the first attempt and can still halt.

## Changes Made

The sentence is the classifier.  HTTP 400 and the adapter's HTTP 422 wrapper of a 200 error envelope that contains it are retryable.  HTTP 5xx, HTTP 401, HTTP 403, buying power, and a plain HTTP 400 stay loud.  "unexpected error occurred" is still an infrastructure failure.  This sentence is not.

The preview probe retries the sentence three times (400ms, then 1200ms) inside one health sample.  A real equity, bracket, or option POST does the same only after a tag lookup misses.  A lookup hit returns that order id and does not POST again.  A lookup failure rethrows the original error and does not POST again.  A network error on a write is still one attempt.

`checkBrokerHealth` maps the sentence to `transientBrokerError` with category `connectivity`.  `applyBrokerOrderPlacementPause` returns `none` without touching the connectivity streak and without halting.  An account that is already auto-halted stays `still_paused` until a healthy probe resumes it.  The in-run skip is status `skipped` with audit `run_skipped_broker_transient`.  The scheduler gate does not persist `skipped_broker_unhealthy` for that skip.

Sandbox (`environment === "paper"`) equity and option placement throws before any POST during the first 15 minutes of the regular session (09:30 ET inclusive, 09:45 ET exclusive).  Live Tradier is not deferred.  Premarket, including the 5:41am CT hit, is not deferred.  The deferral message classifies as retryable and is not an infrastructure failure.

- `src/lib/tradier-transient.ts`
- `src/lib/tradier.ts`
- `src/lib/broker-health.ts`
- `src/lib/execution-mode.ts`
- `src/lib/placement-outcome.ts`
- `test/tradier.test.ts`
- `test/broker-health-auto-pause.test.ts`
- `test/placement-outcome.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-10-14-tradier-sandbox-open-400.md`

## Decisions & Trade-offs

Retry budget is three attempts including the first try, inside the 30s health-probe deadline.  The tag lookup is page 1 with `includeTags`.  A just-accepted order is on that page.  One `trackHealth` wraps the whole sequence so a recovered blip is not five tradier-broker hard-failure rows.

The 15-minute deferral is sandbox only and only while `currentMarketSession` is `regular`.  It does not cover the 5:41am CT premarket failure.  That case is the retry and the no-halt classifier.

`docs/EFFORT-LOG.md` was not edited.  It is archived.  This seat has no Fleet Linear credentials (`board whoami` failed: `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` are unset, and `/home/ubuntu/.secrets/Linear/Fleet.env` is missing).  No Linear issue was created.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx vitest run test/tradier.test.ts test/placement-outcome.test.ts test/broker-health-auto-pause.test.ts
```

`npm run lint` exited 0 (0 errors, 866 grandfathered warnings).  The first `npx tsc --noEmit` failed on the tag-hit return cast and on optional `placeOptionOrder`.  Both were fixed (`as unknown as T`, and a missing-method throw in the two option tests).  A second `npx tsc --noEmit` exited 0.  `npm run build` exited 0.  The targeted vitest run was 108 passed.  Full `npm test` was 9289 passed, 51 skipped, and 23 failed.  The failures are outside this diff: sandbox OpenRouter and notify credentials, host metadata, an Alpha Vantage pool count, and `scripts/ops/summarize-cpuprofile.mjs` under Node's ESM `.ts` loader.  None are in `test/tradier.test.ts`, `test/broker-health-auto-pause.test.ts`, or `test/placement-outcome.test.ts`.

## 2026-10-14 Codex Autofix Round — PR #4668 review findings

### Context & Objective

Two Kody threads on this branch.  Both were clear enough to fix rather than escalate.

### Changes Made

- **Stale fill data on the tag-hit path (correctness).**  `postOrderToleratingTransientServerError` returned `{ order: { id: existing, status: "pending" } }` on a tag hit.  That stub dropped `exec_quantity` and `avg_fill_price`, so an order that filled during the ~1.6s lookup+backoff window was booked as unfilled at the proposal price.  `placeEquityOrder`'s own comment three hundred lines down says exactly that this "corrupts positions and P&L" — the new path reintroduced the bug that comment exists to prevent.  Added `fetchPlacedOrderBody`, which re-reads the order by id so `status` / `exec_quantity` / `avg_fill_price` carry the broker's real state.
- **Unvalidated HTTP boundary.**  `findOrderIdByTag` typed-accessed the `GET /orders` envelope.  Added `TradierOrdersPageSchema` (Zod) and parse it before reading `.orders` / `.order`.

### Decisions & Trade-offs

**A failed re-read falls back to the stub instead of rethrowing.**  On this path the tag hit has already proved the order is on the book.  Throwing would surface a retryable placement failure for a live order and risk a duplicate POST — strictly worse than reporting a conservative pending state.  Same reason the schema parse failure is a clean tag *miss* rather than a throw: throwing would abort the placement the whole retry path exists to survive.

**The envelope schema is deliberately not `.strict()`.**  Kody's suggested snippet used `.strict()` on the page object.  Tradier's orders envelope carries other top-level keys, and a strict parse would fail on a perfectly good live response — converting a working retry into a hard placement failure.  Only `orders` is constrained, and rows pass through untouched because callers read a wide, evolving field set off them.  `orders` is `nullish` rather than `optional` because an empty listing is `orders: null`.

**Left open: the `placement-outcome.ts` HIGH thread.**  That is Sentry's bug-prediction bot, not one of the three review bots this fixer answers, so it is not resolved.  Its subject — whether a retryable `not_placed` should reconcile placement before booking — is a placement-semantics design decision with real duplicate-order trade-offs, not a mechanical fix.

### Files touched

- `src/lib/tradier.ts` — `TradierOrdersPageSchema`, `fetchPlacedOrderBody`, validated `findOrderIdByTag`, tag-hit re-read, `import { z } from "zod"`.
- `test/tradier.test.ts` — three regression tests (real fill state carried through; re-read failure keeps the id without a second POST; drifted envelope is a miss, not a throw).
- `STATUS.md`, this note.

### Verification State

```bash
git merge origin/main          # twice; clean both times, package-lock.json only
npx tsc --noEmit               # exit 0
npm run lint                   # exit 0 — 0 errors, 866 grandfathered warnings
npx vitest run test/tradier.test.ts test/placement-outcome.test.ts test/broker-health-auto-pause.test.ts
npm test
npm run build                  # exit 0 (only pre-existing "no Sentry auth token" warnings)
```

Targeted vitest was 96 passed, then 111 after the `origin/main` merges.  Full `npm test` reported 13 failures in `test/chat-llm.test.ts`, `test/framework-review.test.ts`, `test/llm-provider.test.ts`, and `test/openrouter-credits.test.ts`.  Those four files are unrelated to this diff and reproduce **identically on unmodified `origin/main`** (checked in a throwaway worktree at `f7a06863`): this sandbox has an `OPENROUTER_API_KEY` in the environment, and those tests assert the no-key-configured branch.  CI has no such key, so they pass there.

### Next Steps & Blockers

`do-not-automerge` stays.  Jay squash-merges.

## Next Steps & Blockers

Label `do-not-automerge`.  Jay squash-merges.  Do not enable auto-merge and do not merge from this lane.  Create or move the Linear team `ST` issue once a seat with Fleet credentials picks this up.  Premarket sandbox 400s still reach the broker.  Only the regular-open window is deferred.
