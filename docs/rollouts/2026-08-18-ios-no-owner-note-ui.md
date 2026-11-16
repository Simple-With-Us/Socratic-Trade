# 2026-08-18 — Strip leaked coordinator notes from iOS UI

## Context & Objective

Owner ruled that coordinator/owner comments do not belong in the iOS UI.  Notes meant for Jay stay in PRs and docs, not user-visible copy.  `main` already shipped a Home Desk subtitle (`full surfaces, not just the remote`) that is that leak.

## Changes Made

Removed the leaked Desk subtitle and the same class of owner-note strings on iOS.  Headings stay; replacements are product copy or no subtitle.  Did not add new owner-note UI strings.  Did not steal #2792/#2798/#2800/#2794 (FilingAPI, alert-noise, Pinecone writes, iOS console handoffs).

Touched files:

- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/DataSourcesSettings.swift`
- `ios/SocraticTrade/InsightsView.swift`
- `ios/SocraticTrade/GuardrailsView.swift`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-18-ios-no-owner-note-ui.md`

Copy replacements:

- Home Desk: heading stays `Desk`, subtitle removed
- Home setup: `Connect a broker account and a symbol universe, then tap Run Once.`
- Data sources loading: `Loading data-source settings…`
- Data sources footer: `Advanced knobs change which sources the desk pulls.  Keys stay on Connections.`
- Insights cycle card: subtitle removed (body already points at Home / Run Once)
- Guardrails rulebook: `additional policy fields`
- Guardrails tighten: subtitle removed
- Guardrails missing command: `This server does not support tightening guardrails from the phone.`

Left #2794's readiness / "full desk" / desktop-console handoff strings alone.

## Decisions & Trade-offs

- No subtitle on Desk rather than inventing a new one.  Shortcuts already name Coach / Scan / Guardrails / Results.
- Scanned iOS user-visible strings for remotes, surfaces, Infisical, owner cuts, other agents, and leaked API paths.  Code comments and `#2794` Home readiness copy were left untouched.
- This PR does not touch console files, so console Infisical copy on Settings / admin ops was not rewritten.

## Verification State

- `npm run lint` — exit 0 (0 errors, grandfathered warnings only)
- `npx tsc --noEmit` — exit 0
- `npm run build` — exit 0
- `npm test` — Cloud VM outbound HTTP flakes (SEC `company_tickers.json` 404, FRED, Finnhub, TwelveData).  Unrelated to iOS copy.  Stopped after 10m; GitHub `verify` is the full-suite gate.
- `xcodebuild` — not available in this Cloud VM.  Next Mac compile / TestFlight is the first Swift compile.

## Next Steps & Blockers

- Merge this small copy PR.  `#2794` still owns Safari console handoffs and the readiness "full desk" rewrite.
- No iOS compile in this Cloud VM (`xcodebuild` is not available).  Next Mac `xcodebuild` / TestFlight is the first Swift compile.

## Zero-Code Findings

None.  This is a copy-only fix of a leak already on `main`.
