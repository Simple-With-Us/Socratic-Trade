# 2026-08-14 — Pickup: Monet iOS loading graphic and Lato closeout

## 1. Context & Objective

Owner directed GROK to finish Monet's leftover from the "iOS loading graphic and
font..." session.  Product code was already on `main` as #2667 (`73dab29d`).  The
session dropped after a production 503 (SEC ingest event-loop stall) blocked the
last live Lato computed-font check, and the native splash / wordmark-unflip /
Lato bundle still needed a TestFlight path.

## 2. Changes Made

No product code.  This is a verification + board closeout of work that already
shipped.

- Confirmed production is healthy again (`/api/health` 200, `ok: true`, scheduler
  18s, release `f218f7e3` at probe time; later `origin/main` moved to `2a795b25`
  / #2713).  The 503 Monet saw was the known post-#2679 SEC ingest stall, not
  #2667.  Site recovered without this seat flipping Infisical knobs.
- Finished the leftover production Lato check that Monet could not run while the
  origin was 503:
  - Login HTML references eight hashed `woff2` files.
  - All eight return `HTTP/2 200` with `content-type: font/woff2`.
  - Live CSS sets `--font-sans: var(--font-lato), …` and
    `--font-lato: "lato","lato Fallback",…`.
  - Playwright against `https://socratictrade.com/login` at 375×812:
    `getComputedStyle(document.body).fontFamily` starts with `lato`; the Sign in
    with Google button does too; `document.fonts` lists 9 Lato faces; weight 400
    regular is `loaded`.
- Confirmed the native half is already on TestFlight.  Last successful ship
  `~/.cache/ios-fleet/last-ship-socratic.txt` is `f9c89b9a` (2026-08-14 02:24 CDT).
  `73dab29d` (#2667) is an ancestor of that SHA.  After this pickup started,
  #2692 landed more `ios/**` (quote Key Stats / tappable cards) — a different
  lane.  ASC latest build `1.0.13 (202608140722)` is `VALID`,
  `usesNonExemptEncryption=false`, `internalBuildState=IN_BETA_TESTING`, and
  already contains the splash / unflipped wordmark / iOS Lato.  This pickup did
  not cut a new ship just to fold in #2692.
- iOS simulator rebuild of current `main` was started from
  `~/apps/trading-grok-lato-tf` but sat in `CreateBuildDescription` behind
  other seats' `xcodebuild`s.  Monet already screenshotted the splash on
  2026-08-12 (that is how the mirrored wordmark was found).  TestFlight
  `1.0.13` is the install path.

### Files touched (this pickup)

```
STATUS.md
docs/EFFORT-LOG.md
docs/rollouts/2026-08-14-pickup-monet-loading-fonts.md
```

Live board (untracked): `/Users/jay/apps/TRADING-EFFORT-LOG.md` — same row
flipped in place.

## 3. Decisions & Trade-offs

- **Did not pause SEC ingest or bounce prod.**  Monet left that as an owner
  call.  By the time this pickup started the site was already 200 and healthy,
  so flipping `SEC_INGEST_WORKER_ENABLED` / `SEC_FILING_RAG_MAX_PER_RUN` would
  have been an unrelated production config change.
- **Did not cut a new TestFlight.**  The scheduled Mac-runner ship already
  delivered #2667 as `1.0.13 (202608140722)`, and testers can install it
  (`IN_BETA_TESTING`).  Re-shipping the same `ios/**` tree would only advance
  the marketing sequence.
- **Did not adopt `~/apps/trading-grok-ios-tf`.**  That worktree is 103 commits
  behind `main` and carries unrelated dirty ASC-screenshot `#if DEBUG` hooks.
  Pickup used a fresh `~/apps/trading-grok-lato-tf` on `grok/monet-lato-closeout`.

## 4. Verification State

```bash
curl -sS https://socratictrade.com/api/health   # 200, ok:true
curl -sSI https://socratictrade.com             # HTTP/2 307 -> /login
# eight /_next/static/media/*-s.p.woff2 -> 200 font/woff2
# playwright 375x812 on /login: computed body + button = lato; 400 regular loaded
node ~/apps/ios-fleet/asc-api.mjs GET \
  "/v1/builds/b9c97f70-e204-4ee9-93e4-a41daa5596c7?include=preReleaseVersion,buildBetaDetail"
# 1.0.13 / 202608140722 / VALID / IN_BETA_TESTING
git merge-base --is-ancestor 73dab29d f9c89b9a   # yes
# later ios/ on main is #2692 quote-sheet only, not splash/Lato
```

iOS simulator rebuild of this `main` was started (`xcodebuild` → iPhone 17 Pro)
but had not left `CreateBuildDescription` by closeout time (two other
`xcodebuild`s were already holding the Mac).  Native verification for this
pickup is therefore ASC `1.0.13 IN_BETA_TESTING` + Monet's 2026-08-12
simulator screenshots, not a fresh sim capture.

## 5. Next Steps & Blockers

- Owner: install / update TestFlight `1.0.13 (202608140722)` on the phone to see
  the candlestick splash, unflipped wordmark, and Lato.  Internal testing is
  already open.
- Still out of scope (Monet §5): parallelise `getDashboardSnapshot`'s sequential
  broker chain (~24s worst case).
- SEC ingest event-loop stall remains a live production risk (CLAUDE's ingest
  re-enable).  Not this lane.

## 6. Zero-Code Findings

- Monet's "needs a TestFlight build" was true at session drop and became false
  at 2026-08-14 02:24 CDT when the scheduled `ios-ship.yml` / local ship of
  `f9c89b9a` landed `1.0.13`.
- Production Lato was already serving; the only missing receipt was a computed
  `getComputedStyle` against the live origin, which the 503 had blocked.
