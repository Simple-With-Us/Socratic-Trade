# 2026-06-21 — Learned-context risk-classifier hardening

## Summary

Hardened the single security-critical chokepoint of the crossover-learning loop,
`classifyRiskTier` in `src/lib/learned-context/classify.ts`, to close the
false-NEGATIVE holes an investment-expert panel found — without creating reviewer
fatigue (false positives on legitimate company-fundamental facts). Added a
build-failing regression battery (12 critical-escape tests + 6 legitimate-fact
tests) to `test/learned-context.test.ts`. The classifier stays FAIL-CLOSED:
unknown → `risk`.

## Why (panel findings addressed)

- **Subject gate was a no-op (critical).** `RISK_SUBJECTS` matched only `subject`,
  but producers emit `fact:NVDA`-style subjects, so step 1 never fired for
  chat/post-mortem facts and any risk vocabulary living in the value/intent
  fields escaped (e.g. `max_order_notional` mentioned in prose).
- **Numeric pattern too narrow (high).** `NUMERIC_RISK_PATTERN` ran on `value`
  only, required two digits before `shares|dollars` (single-digit counts escaped),
  and recognized only percent/dollar/shares — missing bps, `N:1`, `Nx`/`N times`,
  ADV/ADTV, and bare counts. So "put on 3x the usual clip" and "coefficient closer
  to 15" escaped.
- **Advisory-fact vs risk-directive is not cleanly separable (high).** Conviction,
  certainty ("never draws down"), correlation-collapse ("treat NVDA/AMD/AVGO as one
  position"), and stop-manipulation move risk WITHOUT naming a knob and were
  invisible to all three checks.
- **Over-broad single words (medium).** Bare `margin`/`cap`/`size`/`limit`/
  `lower`/`raise`/`increase`/`decrease`/`exposure`/`allocation` false-gate common
  fundamentals (gross margin, market cap, raised guidance) → reviewer fatigue.

## Fixes

1. **Full-haystack subject match (the #1 fix).** `RISK_SUBJECTS` now matches the
   full `subject + value + intent` haystack (with a space-condensed variant so
   `strategyAuthority`/`maxOrderNotional` still hit multi-word subjects). Short
   acronym/word subjects (`adv`, `pdt`, `borrow`, `locate`, `kelly`, `vwap`,
   `twap`, `reg t`, `notional`) are WORD-BOUNDARY matched via
   `BOUNDARY_ONLY_SUBJECTS` so they don't substring-collide with prose
   ("adv" ⊄ "advisory").
2. **Numeric fix.** `NUMERIC_RISK_PATTERN` now runs on the full haystack, allows
   one-or-more digits, and adds units: bps/basis points, `N:1`, `Nx`/`N×`/
   `N times`, ADV/ADTV, and bare `N shares|lots|clip`. A separate cue-anchored
   `hasCueNumeric` catches unit-less magnitudes that sit next to a sizing/
   coefficient cue ("coefficient closer to 15", "run it as half the book")
   WITHOUT firing on dates/ordinals ("earnings on the 20th").
3. **Risk subjects added (scoped).** Concentration, position count, single name,
   net/gross/factor exposure, drawdown, value at risk, tail risk, hedge ratio,
   hedging, beta target, cash level/target, fully deployed, correlation, factor/
   sector/style tilt, conviction, win rate, expectancy, notional, order/trade/lot
   size, volatility target, kelly, thesis/signal weight, signal half life, holding
   horizon, turnover, rebalance, trailing stop, price target, buy the dip,
   day trading, pdt, short locate, locate, borrow, hard to borrow, restricted/
   blocked list, compliance hold, trading restriction, suitability, maintenance
   margin, margin call, margin requirement, buying power, wash sale, short selling
   enabled, leverage ratio, reg t, adv, average daily volume, market impact,
   participation rate, time in force, vwap, twap, slippage, exit horizon,
   execution cost, cost model. Margin is scoped to phrases
   (`margin call`/`on margin`/`maintenance margin`/…), exposure to risk-shaped
   phrases (`net/gross/factor exposure`, `increase/reduce/add/cut exposure`).
4. **Intent phrases added.** The specific multi-word idioms (substring-matched):
   concentrate, diversify, high/very high/low conviction, sure thing, near
   certainty, guaranteed, risk-free, cant/cannot lose, no downside, bulletproof,
   safe bet, no-brainer, free/easy money, always pops, never fails, never draws
   down, back up the truck, load the boat/up, pile in, press the trade, full send,
   go all in, all-in, max out, let it ride, let winners run, swing for the fences,
   bet big, go heavy, tilt/skew toward, concentrate into, must own, add to/keep
   adding winners, comfortable with bigger swings, willing to stomach, scale
   back/in/out, pare down, trim/drop the hedge, remove/widen/loosen/pull the stop,
   give it room, room to breathe, without a stop, take chips off, play it safe,
   stay small, lock in gains, upsize, size up, outsized, pyramid, treat them as /
   effectively one position, interchangeable, no locate, not restricted, eligible
   to trade, wash sale expired/safe, ample buying power, 3x the usual, usual clip.
5. **False-positive tightening (anti-fatigue).** Bare `margin`/`cap`/`size`/
   `limit` removed/scoped. The ambiguous directional verbs
   `increase`/`decrease`/`raise`/`lower` and the bare nouns `exposure`/
   `allocation`/`allocate` are routed through an `AMBIGUOUS_DIRECTIONAL`
   co-occurrence gate: they fire ONLY when a risk subject or a numeric also appears
   in the haystack — so "raised guidance" / "revenue increased" / "exposure to
   China" stay `fact`. `aggressive`/`conservative` kept (agent-intent risk
   outweighs the fatigue).

## Header / comment updates

- `classify.ts` header now states the two channels explicitly: the PHASE-0 test
  guards the **DATA channel only** (proves `applyDeterministicSizing` never reads a
  learned row — output byte-identical with/without rows), and documents the KNOWN
  **SEMANTIC-channel residual** (a `fact` that primes a higher `confidenceScore`
  can enlarge size via `strategy.ts:633/640/659`; evidence floor at
  `strategy.ts:651-653` protects unproven theses, making it a slow-burn anchoring
  attack on already-proven ones). The full fix (per-name/per-theme volumetric cap
  or a semantic gate) lives outside the classifier; the classifier mitigates it
  only insofar as conviction/certainty phrases now route to `risk`.
- PHASE-0 test comment in the spec mirrors the same DATA-channel-only scoping.

## Files

- `src/lib/learned-context/classify.ts` — rewritten classifier (full-haystack
  subject match, numeric fix + cue-numeric, expanded/scoped vocab, co-occurrence
  gate, boundary-only short subjects, header rewrite).
- `test/learned-context.test.ts` — PHASE-0 describe/comment rescoped to DATA
  channel; added two build-failing describe blocks: 12 critical-escape tests
  (`→ risk`) and 6 legitimate-fact tests (`stay fact`).
- `docs/rollouts/2026-06-21-classifier-hardening.md` — this note.

## Verification

- `npx tsc --noEmit` → clean (exit 0).
- `npm test` → 77 files, 685 tests, all pass (was 35 in the learned-context file;
  all 12 escapes + 6 fact tests green).

## False-positive judgment — terms deliberately NOT added as bare/forced

- **bare `margin`** — removed; collides with gross/operating/net PROFIT margin.
  Scoped to `margin call`/`on margin`/`maintenance margin`/`margin requirement`/
  `margin account`/`margin headroom`.
- **bare `cap`** — never added as a standalone subject; collides with market cap /
  small-cap / cap-ex. Only `sector cap`/`position cap` style phrases fire.
- **bare `size`/`sizing`** — not added; collides with deal size / market-cap size.
  Sizing intent comes via `position sizing`/`order size`/`size up`/`upsize`.
- **bare `limit`** — not added; collides with limit order / rate limit. Only
  `daily limit` (existing) and explicit risk-limit phrasing.
- **bare `increase`/`decrease`/`raise`/`lower`** — NOT forced on their own
  (gated by co-occurrence) so "raised guidance" / "revenue increased" stay `fact`.
- **bare `exposure`/`allocation`** — NOT forced on their own (same gate) so
  "exposure to China" / "capital allocation discipline" stay `fact`; the
  risk-shaped phrases (`net/gross/factor exposure`, `increase/reduce exposure`)
  fire directly.
- **`$2T`-style market-cap dollar amounts** — the mandated dollar-numeric rule
  catches these, so the spec's illustrative "market cap is $2T" is over-gated by
  design. This is an accepted, documented residual (fail-closed is safe; bare
  "cap"/"market cap" itself does NOT fire). The fact battery instead asserts the
  no-$ form ("large-cap … huge market cap") stays `fact`.

## Follow-ups / residual

- **SEMANTIC channel (known residual).** A clean `fact` that primes high LLM
  confidence can still inflate size on an already-proven thesis. Mitigated here
  (conviction/certainty phrases → `risk`) but the durable fix — a per-name/
  per-theme volumetric cap on accumulated facts, and/or capping confidence-to-size
  for uncorroborated theses — must land before autonomous use.
- A keyword/phrase blocklist over free prose is paraphrasable; medium-term move to
  an allowlist of templated structural facts or a semantic gate (panel rec).
