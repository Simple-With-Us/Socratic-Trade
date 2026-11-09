# 2026-08-02 — Data-provider hardening Round 2/3

**Seat:** MONET · **Branch:** `monet/data-cascade-providers-round2` · **Worktree:**
`/Users/jay/apps/socratic-monet-data-cascade` (fresh branch off `origin/main` post-#2353, distinct
from the Round 1 branch which is fully merged)

## 1. Context & Objective

Direct continuation of Round 1 (`docs/rollouts/2026-08-02-data-provider-hardening.md`, PR #2353):
owner asked to keep going on the remaining `docs/market-data-free-tier-research-2026-08-02.md` §1/§2
items — 3 existing-provider hardening tasks (Yahoo, Alpha Vantage, Finnhub) and 7 new-source
build-outs (BLS, S&P 500 mirror, Nasdaq calendars, Wisesheets, SimFin, Marketaux, USAspending).

Given the genuine parallel structure (7 independent new-file tasks + 3 sequential same-file edits)
and this session's ultracode mode, this round ran as a 10-agent Workflow rather than solo turn-by-turn
work, followed by a manual integration pass (cascade registration, macro.ts wiring, docs) done directly
rather than delegated, since that part is correctness-critical and benefits from the architectural
context already built up in Round 1.

## 2. Changes Made

**New standalone modules (each independently built, tested, and committed by its own workflow agent):**
- `src/lib/market-signals/bls.ts` — BLS API v2 (works keyless at a lower rate, or with a free
  `BLS_API_KEY` at a higher one). Live-verified against the real `api.bls.gov` endpoint.
- `src/lib/market-signals/sp500-constituents.ts` — S&P 500 constituents mirror
  (github.com/datasets/s-and-p-500-companies, PDDL). No consumer wired — see Decisions below.
- `src/lib/nasdaq-calendar-provider.ts` — keyless earnings-calendar `daysToEarnings` backfill.
- `src/lib/wisesheets-provider.ts`, `src/lib/simfin-provider.ts`, `src/lib/marketaux-provider.ts` —
  key-gated fundamentals/news providers, dormant until their env key is set.

**Integration pass (this session, done directly — see Decisions §3 for why):**
- `src/lib/data-providers.ts` — imported and registered `NasdaqCalendarEnrichmentProvider`,
  `WisesheetsEnrichmentProvider`, `SimFinEnrichmentProvider`, `MarketauxEnrichmentProvider` in
  `getEnrichmentProvider()` at cascade positions matching each provider's own recommendation. None
  needed a `provider-rate-limit.ts` entry — all four self-pace in-process (Quiver precedent).
- `src/lib/macro.ts` — wired BLS into `fetchVixOnlyFallback` alongside VIX/Treasury; added
  `MacroData.nonfarmPayrollsChangeK` (no FRED equivalent exists — FRED's PAYEMS is a level, not this
  MoM delta) and `blsSourced` (mirrors `treasurySourced`'s honesty contract).
- `app/console/macro/indicators.ts` / `page.tsx` — new `bls` sourcing dimension; CPI, unemployment,
  the misery index, and a new nonfarm-payrolls tile now light up from FRED OR the keyless BLS
  fallback. `UnsourcedNotice` rewritten to build its "what's live" clause as a list rather than
  hand-enumerating vix/treasury/bls combinations.
- `.env.example`, `docs/market-data-provider-pricing.md` — every new env var + live-verified vendor
  fact, including 2 corrections to the ORIGINAL research doc (SimFin's real rate limit is 2 req/sec
  with no monthly cap, not "500 credits/mo"; Finnhub has zero existing insider-transactions logic to
  add headroom to, contrary to that doc's claim).

**Existing-provider hardening (edited in place, sequential — each agent confirmed the prior one's
commit existed before starting):**
- Yahoo: HTTP 429 exponential backoff added to the two `v8/finance/chart` call sites that lacked it
  (`history.ts`'s `fetchYahoo`, `macro.ts`'s `fetchVixLane`). The crumb+cookie handshake this task set
  out to investigate was found to already be correctly implemented where it's actually needed
  (`v10/finance/quoteSummary`) — `data-providers.ts` needed zero changes for that part.
- Alpha Vantage: free `EARNINGS_CALENDAR` fallback for `daysToEarnings`, one market-wide call per
  ~24h, reusing the existing scarce budget (no new quota).
- Finnhub: equivalent `/calendar/earnings` fallback (Finnhub's 60/min tier isn't scarce).

## 3. Decisions & Trade-offs

1. **10-agent Workflow, not solo turn-by-turn.** 7 of the 10 tasks are genuinely independent (each
   creates its own new file(s) with zero shared-file overlap) — real parallelism, not busywork. The
   remaining 3 (Yahoo/AV/Finnhub) all edit the SAME `data-providers.ts`, so those ran strictly
   sequential inside the workflow rather than parallel, to avoid concurrent-edit corruption on one
   file. Every agent was explicitly told NOT to touch `data-providers.ts`/`db-api-keys.ts`/
   `provider-rate-limit.ts`/`.env.example`/the pricing doc/`app/console/**` — those were reserved for
   this session's own integration pass.
2. **Verified every self-reported result against the actual repo before trusting it** (trust but
   verify): re-ran `tsc --noEmit` + all new/touched test files independently (429 tests, 16 files, all
   green) rather than accepting the agents' own pass/fail claims. One agent's structured-output
   capture for S&P 500 came back as literally `{"summary":"test","integrationNotes":"test"}` —
   investigated directly via `git show`, confirmed the ACTUAL commit (`c56e41c1`) contains real,
   thorough, well-tested work; the schema call itself just malformed on return. A second finding: two
   agents' commits got bundled together (`d79d3dfa` contains both Wisesheets AND Marketaux's files,
   despite the message only naming Wisesheets) — a `git add`/`git commit` race between concurrent
   agents sharing one non-isolated checkout (file-level edits were safe since each created distinct new
   files; the git *operations* themselves were not, since `add`/`commit` touch the shared index/HEAD).
   Confirmed via `git show --stat` that both files sets are intact and correct, just cosmetically
   mis-attributed — not re-litigated by rewriting history, since 3 more commits had already landed on
   top by the time this was noticed.
3. **S&P 500 constituents mirror: built, NOT wired to replace the static list.** This app's scan
   universe (`index-universes.ts`) uses a compile-time static array (`sp500.ts`'s `SP500_SYMBOLS`).
   Converting that to a runtime-fetched value would ripple into whatever consumes it synchronously —
   a bigger, separate architectural decision than "add a new free source," so the new module ships as
   tested infrastructure for a future refresh, not a live swap.
4. **USAspending.gov: investigated, not implemented — same disposition as FINRA short-interest in
   Round 1.** The award-search API is free/real/well-maintained; the blocker is that no free,
   reliable recipient→ticker crosswalk exists (SEC's own ticker↔CIK data carries no DUNS/UEI field,
   and fuzzy name-matching was live-tested to be genuinely unreliable even for famous defense
   contractors). A narrow hand-curated allowlist would work with zero fuzzy matching but is a
   product-scope call left for the owner, not shipped unilaterally.
5. **Wisesheets/SimFin ship without `debtToEquity`/`returnOnEquity` confirmation** — both vendors'
   public docs only demonstrate a handful of example metric keys; the full metrics catalog needs a
   live API key to query, which no agent may provision. Owner action, not a code gap, once a real key
   exists.

## 4. Verification State

- `npx tsc --noEmit`: clean (checked repeatedly through the integration pass).
- `npm run lint`: 0 errors (663 pre-existing warnings, unchanged from Round 1).
- `npm test`: **5891/5891 passed, 499/499 files** (1018s). No FMP-transcript regressions (that Round 1
  fix stayed fixed).
- `npm run build`: clean.
- Found and fixed one real bug via testing (not just trusting the integration): BLS's own in-process
  cache (`clearBlsMacroCacheForTests`) wasn't being reset between tests, causing a stale cached `null`
  to leak into a later assertion — added to `cache-provenance.test.ts`'s shared `beforeEach`.

## 5. Next Steps & Blockers

**Owner actions:**
1. Sign up for free keys to activate the new dormant providers: Wisesheets, SimFin, Marketaux (each
   just needs its own env var pasted in — see `.env.example`'s new sections for exact names/notes).
   BLS is optional (already works keyless; a free key just raises the rate ceiling).
2. Decide whether USAspending.gov's narrow hand-curated-allowlist option (Decision #4) is worth
   building — it's the only remaining path to that data source without unreliable fuzzy matching.
3. Decide whether `govContractsQuiver` should be renamed source-neutral or left as-is, given it
   currently has zero UI references (found while investigating USAspending — see the pricing doc).
4. Once a real Wisesheets/SimFin key exists, extend their metric coverage (debtToEquity/returnOnEquity)
   per each provider's own `integrationNotes` (recorded in this repo's Slack/effort-log history and in
   the pricing doc's "Known gap" callout).

**Not done, still open from the original research doc:** none of the remaining §1/§2 items — this
round closes out everything that was still queued after Round 1, except USAspending (investigated,
correctly deferred) and the S&P 500 mirror's live-wiring (deliberately deferred, see Decision #3).

## 6. Zero-Code Findings

- **SimFin's real free-tier rate limit is 2 req/sec with no monthly cap** — the original research
  doc's "500 credits/mo" figure was a different in-app feature entirely. Corrected in the pricing doc.
- **Finnhub has zero existing insider-transactions logic** — the original research doc's claim that
  it "has more headroom than drawn" doesn't hold; there's no existing draw to extend.
- **Marketaux's ToS is genuinely clean for this use case** — the original "unverifiable" finding was
  from checking the wrong URL (a 404). The real ToS has no commercial-use restriction relevant here.
