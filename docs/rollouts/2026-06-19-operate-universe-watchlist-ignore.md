# Operate Universe, Watchlist, and Ignore List

## Summary

- Replaced the Settings → Operate single-index dropdown with large multi-select
  Base index toggle buttons for S&P 500, Nasdaq 100, and Dow 30.
- Made S&P 500 the default starting universe for new/default policies, including
  a one-time migration for untouched legacy empty defaults.
- Renamed custom additions to **Additional Watchlist** and added an adjacent
  **Ignore List** that subtracts symbols from the selected indexes and watchlist.
- Added shared backend index-universe metadata so policy expansion, API
  validation, UI counts, and LLM tuning context use the same supported index
  set.
- Made Smart Money congressional/insider tickers open the symbol drawer even
  when a symbol is not present in the latest scan payload.
- Added in-app helper text clarifying that `Run during extended hours` controls
  strategy-run timing, not automatic extended-hours order permission.

## Why

The previous Operate UI made the universe model look like one base dropdown plus
extra symbols, even though the policy schema is a composite universe. The
backend type also advertised unsupported index values, which could confuse both
users and LLM strategy tuning. The UI now shows the actual model: selected
indexes plus additional watchlist symbols minus ignored symbols. Starting with
S&P 500 also prevents a new user from landing in a blank universe unless they
explicitly remove it. The migration is guarded by an internal setting so an
intentional later removal is not undone on the next restart.

## Files

- `app/api/policy/route.ts`
- `app/api/strategy/enable/route.ts`
- `app/dashboard-client.tsx`
- `app/ui/dashboard/settings.tsx`
- `app/ui/dashboard/views.tsx`
- `src/lib/index-universes.ts`
- `src/lib/db.ts`
- `src/lib/defaults.ts`
- `src/lib/policy.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/types.ts`
- `test/policy-default-universe.test.ts`
- `test/policy.test.ts`
- `test/strategy-tuning.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-19-operate-universe-watchlist-ignore.md`

## Verification

- `npx tsc --noEmit` initially failed on the new policy test object inferring
  `includedIndices` as `string[]`; annotating it as `TradingPolicy` fixed the
  issue.
- `npx vitest run test/policy-default-universe.test.ts` passed: 1 file, 2 tests.
- `npx tsc --noEmit` passed.
- `npm test` passed: 33 files, 250 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `rm -rf .next && pm2 restart trading-codex` restarted the Codex preview after
  the build regenerated `.next`.
- `curl -sS -o /tmp/trading-codex-health.json -w '%{http_code}\n' http://127.0.0.1:4101/api/health` returned `200`.
- `curl -sS http://127.0.0.1:4101/api/policy` returned
  `includedIndices:["sp500"]` for the running preview's active policy.
- The first cold dev `GET /` after restart emitted the known transient
  `500`/pipe error while compiling. After warm compile, `/api/health` returned
  `200`, `HEAD /` returned `200`, and identity-encoded `GET /` returned `200`
  with a 140,666-byte response. Plain curl still reported `curl: (18)` after
  reading a `200`, which appears to be the existing Next dev stream-length quirk
  rather than an HTTP status failure.
- In-app browser visual verification was attempted against
  `http://127.0.0.1:4101`, but Browser Use blocked the URL by policy. No
  alternate browser surface was used.

## Follow-ups

- Replace static index snapshots with a maintained provider-backed constituent
  refresh path if the app starts relying on exact real-time index membership.
- Add a visible control for `permitExtendedHours` before allowing extended-hours
  order placement from the UI.
