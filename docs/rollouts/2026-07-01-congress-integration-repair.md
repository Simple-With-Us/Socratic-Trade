# 2026-07-01 — Congress.Trade integration repair (Workstream C1)

Implements Workstream **C1** from `docs/reviews/2026-07-01-audit-work-split.md`
(the cross-app section of `docs/reviews/2026-06-30-improvement-audit.md` §6.8).
Repairs the drifted Congress.Trade (App A) <-> Agentic Trading (App B) side-channel
across the App B repo and the shared package pin; the matching App A changes ship in a
separate PR in `jaywedgeworth22/Congress.Trade` (see Follow-ups).

## Summary (what changed — App B)

1. **Push/SSE contract (item 1) — adopt App A's live subscription model.**
   `src/lib/congress-stream.ts` was rewritten. App A's `GET /api/stream` **requires**
   `?subscription=<id>` and authenticates a per-subscription secret; the old consumer
   connected with only a bearer header and **no `?subscription=`**, so App A answered
   `400 missing ?subscription=` on every attempt — the push path was dead. Now the consumer:
   - resolves a subscription: operator-provisioned via env
     (`CONGRESS_STREAM_SUBSCRIPTION_ID` + `CONGRESS_STREAM_SUBSCRIPTION_TOKEN`), or an
     opt-in auto-created one (`CONGRESS_STREAM_AUTO_SUBSCRIBE` → `POST /api/subscriptions`,
     cached per process);
   - connects to `/api/stream?subscription=<id>` with the secret as `Authorization: Bearer`;
   - maps App A's raw `event: trade.new` Transaction **explicitly** into a canonical
     `{ type:"congress.trade", id, data:{ transaction } }` envelope
     (`toCongressEventEnvelope`) before `applyCongressEvent`;
   - recognizes App A's control frames (`cursor`/`ping`/`reconnect`/`error`) as no-ops, so
     the every-5s `ping`/`cursor` heartbeat no longer logs `dropped unparseable SSE message`;
   - drops a cached auto-created subscription on `401/404/409` so the next attempt re-provisions.
   Still fully gated by `CONGRESS_STREAM_ENABLED` (default off) → inert until an operator
   provisions a subscription and enables the flag.

2. **Inbound receiver "drops 4 of 7" (item 2) — corrected: make the asymmetry explicit, not trim/add-tables.**
   Verified the audit/work-split premise was wrong: App A's `POST /securities/import`
   persists **all 7** datasets, and App B's outbound already sends all it has, so the B→A
   donation drops nothing. Only App B's **inbound** receiver
   (`app/api/admin/securities/import/route.ts`) persists 3 (refs/prices/spx) — correct by
   design because App A only pushes those 3 inbound (insider/shortVolume are B-authoritative;
   fundamentals/analyst arrive via the pull enrichment tier). Trimming the outbound (option a)
   would have **broken** the working insider/shortVolume/fundamentals donation; adding tables
   (option b) would duplicate the pull tier with data App A never pushes. Instead the inbound
   route now **explicitly acknowledges** any non-persisted dataset that arrives
   (`acceptedNotPersisted` in the response + audit) so nothing is *silently* discarded, and the
   directional asymmetry is documented in the route header + design docs.

3. **Shared-package pin (item 3) — exact-pin + a real divergence check.**
   Both consumers already resolved to `1.0.0` but via a `^1.0.0` caret; the existing
   `shared-package-pin-check.yml` no-oped for registry/semver pins and never failed. App B is
   now exact-pinned to `"1.0.0"` (`package.json` + `package-lock.json`), and the workflow was
   rewritten to fetch the **peer** repo's (`Congress.Trade` `app/package.json`) shared-pkg spec
   and **fail (exit 1)** when the two normalized versions diverge (runnable via
   `workflow_dispatch` for a dry-run; skips with a notice when `GH_PACKAGES_TOKEN` is absent).
   C1 needs no shared-package **source** change (aliases/types/schemas are all in the published
   1.0.0; only `usageTelemetry`/1.1.0 is C2's concern), so no publish/bump is required here.

4. **Ticker aliasing (item 4, App B side) — apply the shared alias map on outbound rows.**
   App B had **zero** `resolveTickerAlias`/`TICKER_ALIASES` usage (alias-blind
   `normalizeSymbol` = trim+upper). Added `canonicalOutboundSymbol()` =
   `resolveTickerAlias(normalizeSymbol(x))` and applied it to the `ticker` field of every
   outbound row (`marketQuoteToRef`/`Fundamentals`/`Analyst`, `ohlcBarsToPriceEntry`,
   `buildInsiderImport`, `buildShortVolumeImport`) so corporate-action renames (FB→META,
   ATVI→MSFT, SQ→XYZ, …) don't fragment into dead-ticker rows on App A. Share-class hyphens
   (BRK-B) are preserved. (App A retiring its own divergent local `TICKER_ALIASES` copy ships in
   the App A PR.)

5. **Outbound payload validation (item 5) — drop invalid rows instead of warn-and-send.**
   `shareWithCongressTrade` previously ran a whole-payload `SharePayloadSchema.safeParse` and
   **sent anyway** on failure. Replaced with `dropInvalidShareRows`: per-row validation against
   the shared row schemas that **drops** only the genuinely-invalid rows (so one bad row never
   suppresses the valid rows in the same dataset), then `sent`/the empty-check reflect only what
   is actually POSTed. Verified all real outbound `date` fields are already `YYYY-MM-DD` so the
   strict `IsoDateSchema` never drops legitimate insider/shortVolume rows.

## Why

The Congress side-channel had four drifted seams flagged by the 2026-06-30 audit: the push/SSE
half didn't match App A's live subscription contract (so it never connected), the shared package
could silently diverge between the two repos, malformed outbound rows were logged-but-sent, and
neither app applied the shared ticker-alias map. Item 2's "drops 4 of 7" turned out to be
correct-by-design once the real data-flow directions were verified, so it was resolved by making
the behavior explicit/documented rather than by the (breaking) trim or the (redundant) new tables
the source docs suggested.

## Files (App B)

- `src/lib/congress-stream.ts` — rewritten: subscription resolution/creation, `?subscription=` +
  Bearer connect, `toCongressEventEnvelope`, control-frame handling, 4xx re-provision.
- `src/lib/congress-share.ts` — `canonicalOutboundSymbol` + alias on outbound row tickers;
  `dropInvalidShareRows` per-row validation; `shareWithCongressTrade` filters before POST.
- `app/api/admin/securities/import/route.ts` — `acceptedNotPersisted` acknowledgment + directional
  -asymmetry header note.
- `.github/workflows/shared-package-pin-check.yml` — peer-repo divergence check (fails on skew).
- `package.json`, `package-lock.json` — exact-pin shared pkg to `1.0.0`.
- `test/congress-stream.test.ts` — control-frame, envelope-mapping, `resolveSubscription`, and a
  stubbed-SSE-stream end-to-end ingest test asserting the `?subscription=` + Bearer contract.
- `test/congress-share.test.ts` — alias-resolution + `dropInvalidShareRows` drop-invalid tests.
- Docs: `docs/congress-trade-consume.md`, `docs/push-to-app-b.md`, `STATUS.md`, `PLAN.md`, this note.

## Verification (App B)

- `npx tsc --noEmit` — clean.
- `npx eslint <changed files>` — 0 errors (only the file's grandfathered `_url`/`_init` warnings).
- `npx vitest run test/congress-share.test.ts test/congress-stream.test.ts test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts` — 77 passed.
- `npm test` (full) — 1680 passed across 172 files.
- `npm run build` — success (exit 0).

Note: this worktree had no `node_modules`; verification used a symlink to the parent worktree's
`node_modules` (identical `package-lock.json`; installed shared pkg 1.0.0 exports `resolveTickerAlias`).
`npm ci` here needs a `read:packages` GitHub token (the ambient `gh` token lacks that scope).

## Follow-ups

- **App A PR (`jaywedgeworth22/Congress.Trade`):** (item 3) exact-pin `app/package.json` +
  lockfile to `1.0.0` and mirror the peer divergence check in App A's `shared-package-pin-check.yml`;
  (item 4) retire App A's local `app/src/extraction/tickerNormalize.ts` `TICKER_ALIASES` in favor of
  the shared `TICKER_ALIASES` (they're content-identical today but free to drift). NOTE: App A is
  currently checked out on `chore/pin-check-latest-sha-guard`, which also edits the pin-check
  workflow — land the C1 App A changes on their own branch and reconcile that file to avoid a stale
  overwrite.
- **Operator enablement:** the SSE push path stays inert until an operator (a) creates/provisions an
  SSE subscription in App A and sets `CONGRESS_STREAM_SUBSCRIPTION_ID`/`_TOKEN` (or enables
  `CONGRESS_STREAM_AUTO_SUBSCRIBE`) and (b) sets `CONGRESS_STREAM_ENABLED=on`. Until then App B keeps
  sourcing congress data via the existing pull path.
- Consider promoting the pin-check to a required ruleset check once bumps always land as a matched
  pair (kept non-required for now so a coordinated two-repo bump isn't hard-blocked).
