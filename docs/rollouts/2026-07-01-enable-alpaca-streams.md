# 2026-07-01 - enable-alpaca-streams

## Summary

At the owner's explicit request ("I don't want those 3 features turned off for alpaca"),
enabled the three previously-disabled Alpaca WebSocket streams
(`docs/broker-capability-plan.md` §9) in production, and fixed a real bug found while
verifying they actually work: the two stream workers that need a live-authenticated
connection (`alpaca-news-stream.ts`, `alpaca-trade-updates-stream.ts`) were reading Alpaca
credentials from a stale, disconnected legacy store instead of the account the rest of the
app actually uses.

## Why

Flipping the three flags (`STREAMS_ALPACA_NEWS_ENABLED`, `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`,
`STREAMS_ALPACA_PRICE_EVENTS_ENABLED`) plus `TRIGGER_ENGINE` (a prerequisite the price-events
stream refuses to start without — it also broadens scope beyond price events, see
Verification below) revealed both streams reconnecting in a loop with `HTTP 401
Unauthorized` from Alpaca. Root cause: both stream workers resolved credentials via
`resolveApiKey("alpaca_paper_api_key"/"alpaca_paper_secret_key", "local")`, which reads a
standalone legacy row in `user_api_keys`. Querying production directly showed that row was
last touched **2026-06-22**, while the account actually in use (`connected_accounts`,
"Roth IRA", environment `live`) was rotated **2026-06-29** — the legacy row is stale and no
longer a valid Alpaca credential. The rest of the app (market-data enrichment,
`resolveAlpacaMarketData`) already reads from `connected_accounts` and was unaffected; only
these two stream workers still used the old path. `alpaca-trade-updates-stream.ts` also
hardcoded the **paper** WebSocket host (`wss://paper-api.alpaca.markets/stream`)
unconditionally — a live-environment key would 401 there even with a fresh credential,
since Alpaca's trade_updates host is environment-specific.

## Files

- `src/lib/db-api-keys.ts` — added `resolveAlpacaStreamAccount(userId)`: ranks connected
  Alpaca accounts (same store `Settings -> Accounts` writes to) and returns the first
  usable `apiKey`/`apiSecret`/`environment`; falls back to the legacy standalone key pair
  (reported as `environment: "paper"`) only when no connected Alpaca account exists.
- `src/lib/streams/alpaca-news-stream.ts` — uses `resolveAlpacaStreamAccount` instead of
  the legacy `resolveApiKey` calls.
- `src/lib/streams/alpaca-trade-updates-stream.ts` — same credential-source fix, plus picks
  `wss://api.alpaca.markets/stream` (live) vs `wss://paper-api.alpaca.markets/stream`
  (paper) based on the resolved account's environment instead of hardcoding paper;
  threaded the environment through the `connect`/`scheduleReconnect` reconnect chain.
- `test/key-resolution-tiering.test.ts` — new `resolveAlpacaStreamAccount` describe block:
  prefers connected Alpaca accounts, reports the correct environment, falls back to the
  legacy pair when no connected account exists, explicitly regression-tests the stale-vs-
  fresh-credential scenario from production, returns `undefined` with neither source, and
  covers the case where another broker/Test account is currently active.

## Production changes (not in git — infra, not code)

- Created `~/apps/trading-live/.env.local` with the four flags above. Production secrets
  live in Infisical (this app's actual secret store); this file is a plain, non-secret
  local override layer Next.js merges on top — chosen instead of writing to Infisical
  because I did not have (and deliberately did not go looking for) the machine-identity
  credentials Infisical writes would require; `.env.local` needed no secret material and
  is fully reversible (delete the file).
- Ran `pm2 restart trading --update-env` to pick up the new flags, twice (once before
  finding the credential bug, once implicitly still pending the code fix's actual deploy —
  see Follow-ups).

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint <touched files>` — 0 errors, 1 pre-existing warning.
- `npx vitest run test/key-resolution-tiering.test.ts` — 28/28 passing.
- `npm test` (full suite) — 168 files / 1616 tests passing.
- `npm run build` — clean.
- **Live production verification** (read-only `pm2 logs`/prod-DB queries, not a code
  change): confirmed `STREAMS_ALPACA_PRICE_EVENTS_ENABLED`+`TRIGGER_ENGINE` took effect —
  the stream logged `no active users with watched symbols; not starting` rather than the
  `TRIGGER_ENGINE is off` warning, i.e. it got past the flag check but has nothing to
  watch: the `local` user's `user_watchlist` table has 0 rows and `policy.additionalSymbols`
  is empty. This is a **content gap, not a bug** — the stream only watches explicit
  watchlist/additionalSymbols entries by design (never a whole index universe, to respect
  the free IEX 30-symbol subscription cap). It will start doing something the moment
  symbols are added to the watchlist or `additionalSymbols`.
- Confirmed via `pm2 logs`/prod DB that `alpaca-news`/`alpaca-trades` streams were
  reconnect-looping on `HTTP 401` before this fix was written — the credential-resolution
  bug above.

## Follow-ups

- **The credential-resolution code fix is pushed to this branch/PR but not yet deployed to
  `trading-live`.** The `.env.local` flags are live now, so the two auth-dependent streams
  will keep reconnect-looping on 401 in production until this fix merges to `main` and a
  deploy runs. Flag explicitly for the owner: do they want this expedited (fast-track
  merge + deploy) given the streams are actively failing right now, or is normal-cadence
  merge/deploy acceptable?
- `TRIGGER_ENGINE=on` has a broader effect than just the Alpaca price-events stream — it
  also enables event-driven strategy runs for any other material-event source in
  `src/lib/triggers.ts` (regime changes, 8-Ks, insider/congress signals, if those code
  paths call `submitMaterialEvent`/`broadcastMaterialEvent`), on top of the existing
  fixed-interval schedule. Guardrails already exist (5 min global cooldown, 30 min
  per-symbol cooldown, 6/hour and 24/day run caps, per `TRIGGER_*` env defaults in
  `triggers.ts`), but this is worth the owner knowing explicitly since it was enabled as a
  side effect of "turn the price-events stream on," not requested on its own merits.
- If the owner wants the price-events stream to actually watch something, populating
  `user_watchlist` (via the dashboard) or `policy.additionalSymbols` is a content
  decision, not a code change — not done here.
- Coordination note: Codex has separate, unmerged work adding new broker integrations
  (per the owner, currently on a dirty local worktree being merged). This change does not
  touch new-broker code and should not conflict, but land Codex's branch with normal
  merge-conflict review once it's pushed, per `AGENTS.md`'s "refuses to auto-merge when
  your branch and origin/main both touched the same files" guard in `scripts/land.sh`.
