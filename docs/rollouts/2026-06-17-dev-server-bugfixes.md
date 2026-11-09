# 2026-06-17 — Dev-server runtime bug fixes

## Summary
Got the app running on the local dev server (`npm run dev`, http://localhost:3000)
and fixed two runtime bugs that crashed it on load. These were latent in the
uncommitted multi-account / Alpaca work — they did not surface in `npm run build`
or `npm test`, only when the dev server compiled and rendered the full graph.

## Bugs fixed

1. **`Module not found: Can't resolve 'crypto'` (`src/lib/db.ts:4`).**
   The connected-accounts / API-key encryption work added
   `import crypto from "crypto"` to `db.ts`. `next.config.mjs` already stubs the
   server-only modules `db.ts` pulls in (`better-sqlite3`, `fs`, `path`, `util`,
   `node:fs`, `node:path`) out of the client/edge bundle, but `crypto` was never
   added to that list, so the non-server webpack graph couldn't resolve it and
   the dev compile failed. Fix: add `crypto` to `resolve.fallback` and
   `node:crypto` to `resolve.alias` in `next.config.mjs`, matching the existing
   stub pattern. `crypto` in `db.ts` is server-only (AES key encryption +
   `randomUUID`/`randomBytes`), so stubbing it client-side is correct.

2. **`Account mismatch` thrown in `AlpacaBrokerGateway.getPortfolio`
   (`src/lib/alpaca.ts:52`), crashing dashboard SSR.**
   `DEFAULT_POLICY.activeBroker` was `"alpaca"`. With no connected account
   configured (`connected_accounts` empty), `getPolicy` inherits `activeBroker`
   from the default while `policy.accountNumber` stays `"RH-MOCK-AGENT"` (from
   the persisted default profile). `getBrokerGateway` then routes to the real
   Alpaca API (live paper keys are in `.env.local`), whose `account_number`
   never matches `"RH-MOCK-AGENT"` → throw → 500 on `/`. Fix: default
   `activeBroker` to `"robinhood"`, which (with `ROBINHOOD_ADAPTER=mock`) uses
   `MockRobinhoodGateway` — no mismatch check, deterministic data, paper-safe.
   Activating an Alpaca connected account in the Integrations UI still sets
   `activeBroker = "alpaca"` *and* the correct `accountNumber`, so real Alpaca
   use is unaffected. Aligns with the repo's paper-by-default policy.

3. **`src/lib/alpaca.ts:163` used `crypto.randomUUID()` with no import** (relied
   on the Node global). Would throw `ReferenceError: crypto is not defined` when
   cancelling an Alpaca order in any runtime without the global. Fix: add
   `import crypto from "crypto"` (bare specifier, matching `db.ts`). Resolves to
   the Node builtin on the server and is stubbed on the client by the
   `fallback.crypto = false` added in fix 1.
   **Gotcha:** do NOT use `import crypto from "node:crypto"` here — this project's
   webpack config does not handle the `node:` scheme on the server bundle and it
   fails with `UnhandledSchemeError: Reading from "node:crypto" is not handled by
   plugins`. Use the bare `"crypto"` form everywhere in server libs.

## Files
- `next.config.mjs` — stub `crypto` / `node:crypto` for the client/edge bundle.
- `src/lib/defaults.ts` — `DEFAULT_POLICY.activeBroker`: `"alpaca"` → `"robinhood"`.
- `src/lib/alpaca.ts` — explicit `import crypto from "crypto"`.

## Verification
- `npm test` → 19 files, 139 tests pass.
- `npm run build` → compiles, type-checks, 11/11 static pages.
- Dev server manual pass (Claude Code preview): page loads (200, was 500);
  Decision / Market Scan / Performance / Tax / Strategy tabs all render;
  Flow view (React Flow) and Symbol Drilldown drawer open without error;
  GET `/api/{dashboard,portfolio,positions,orders,policy,accounts,audit,profiles}`
  all 200. (`GET /api/connected-accounts` → 405 is expected — that route is
  POST-only; the UI reads the list from the SSR snapshot.)

## Follow-ups (not blocking, left as-is)
- A Node `url.parse()` deprecation warning (DEP0169) is emitted from a
  dependency on each render — noise only, no action needed.
- iCloud sync-conflict duplicates (`"<name> 2.ext"`) still litter `test/`,
  `src/lib/web-sources/`, `app/api/scan/`, and `docs/` (gitignored). They are
  cruft but harmless to build/test; not removed in this pass.
