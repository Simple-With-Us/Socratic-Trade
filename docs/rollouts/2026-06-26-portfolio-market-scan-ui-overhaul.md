# 2026-06-26 — Portfolio / Market-Scan / Settings / Help mobile-UX overhaul (+ data & execution fixes)

Branch `claude/portfolio-market-scan-ui-27azkz`. Large operator-driven UX + correctness pass covering
the dashboard header, Portfolio, Market Scan, Congressional/Insider panels, System Help, Settings,
Accounts/Edit-Account, plus several backend correctness fixes. Worked as a team: backend + shared
structural edits landed first (this base), then per-region UI edits fanned out to Sonnet/Haiku/Opus
subagents in isolated worktrees and merged back.

## Summary (what changed)

### Backend / correctness (base commit)
- **Future-dated trades are now an error.** `congress.ts` adds `normalizeTradeDate()` (reuses
  `saneIsoDate`/`toIsoDate`) and `coerceCongressTrade()` rejects any trade whose date is in the future
  (or unparseable). `sec.ts` adds `saneFilingDate()` used by `parseForm4Xml()` + `coerceInsiderFiling()`
  so a future-dated Form 4 (the "Steve Cohen 12/26/2026" bug) is dropped rather than displayed.
- **Market-scan universe = top-N + up to N outliers + holdings.** `market.ts` no longer swaps outliers
  *into* the candidate cap; the candidate set is now the full top-N (`candidateLimit`, default 30) PLUS up
  to `outlierReserve` (default 8) outliers, PLUS any current portfolio holdings not already included.
  Outliers now also include **statistically extreme** names (intraday move or volume in the right tail,
  mean+2σ) via new `tailThreshold()` + `isStatisticalOutlier`, not just web-signal names.
- **Shared-pool contribution defaults ON.** `db-settings.ts` `contributeShared` default `false → true`.
  Tests updated (`learned-context.test.ts`, `learned-context-sharing.test.ts`).
- **Alpaca "Account mismatch" hardened.** `alpaca.ts` `getPortfolio` now compares account numbers
  case/whitespace-insensitively and only throws on a genuine cross-account mismatch (both present and
  different), with an actionable, capitalized "Account Mismatch: …" message instead of bare
  "Account mismatch". Fixes spurious mismatches that aborted autonomous runs (no trades executing).

### Shared structural UI (base commit)
- `overlays.tsx`: large modals (lg/xl/full) now fill the whole screen on mobile (`max-sm` fullscreen +
  edge-to-edge), fixing right-edge clipping on Settings / System Help / Edit-Account.
- `dashboard-client.tsx`: added lucide icons (Columns3, SlidersHorizontal, ChevronDown, Server, Eye,
  EyeOff) centrally; dropped the redundant Settings subtitle and the Accounts "Connect and switch…"
  subtitle (so it no longer mis-describes the Edit view); System Help modal enlarged to `xl`.

### Per-region UI (team of Sonnet/Haiku/Opus subagents in worktrees → patches applied + merged)
- **Congress/Insider panels**: `formatTradeSource` maps raw source keys to display labels
  ("congress.trade" → **Congress.Trade**, "senate-efd" → Senate eFD, …); `formatDateRange` adds the
  time span of the on-file trades to each subtitle; both lists get a bottom buffer so the last row
  isn't clipped.
- **Portfolio**: the Brokerage tag is now green (was red/`down`); the mobile summary's Positions stat
  expands into a scrollable holdings list (symbol/value/P&L).
- **Readiness**: the broker/mode chip removed (it duplicated the Portfolio tag); chips shrink on
  mobile to fit one line.
- **Header**: tighter, less-tall mobile layout; account dropdown drops the "(live)" suffix.
- **Market Scan**: column-picker icon → Columns3, settings icon → SlidersHorizontal (was a gear +
  speedometer); the long scan-detail subtitle collapses behind a toggle on mobile.
- **System Help**: enlarged (`xl`) + mobile-fullscreen; Tax tab label, "Data Sources" tab (was
  "Fintech Studios") covering the full source stack with Fintech Studios as one optional premium
  source; MCP section rewritten generally (this app as the AI-agent example, balanced MCP-vs-REST
  trade-offs, removed the Claude-Desktop command block); `$Unlimited` ceilings fixed; no tab-name
  references.
- **Settings**: "Risk & Safety" → "Safety"; definitions-moved-to-bottom for Tax + Safety + the Tuning
  "skip money-losers" detail; removed the `docs/phase-9…` reference; Effort shown Title-Cased; the
  Connections "Docs" text link became an external-link icon; data-pool contribute toggle reflects the
  new ON default; market-scan copy rewritten for the additive top-N + outliers + holdings model;
  redundant Settings/Accounts subtitles dropped.
- **Display**: the compact-banner toggle became a 3-way **Full / Compact / Hidden** control (Hidden
  removes the account-mode banner entirely).
- **Accounts / Edit-Account**: broker-specific Edit titles; Robinhood-MCP note shows only for
  Robinhood; "Connect Robinhood" / "Connect Alpaca" buttons (MCP option removed); Label default
  "Paper"; italic hints; "(hidden)" on existing API key/secret; Label + Account Number no longer
  optional; "Use a Custom Alpaca Endpoint" full width; responsive single-column form on mobile (fixes
  the right-edge clipping); plus a "Hide Test account" toggle that drops Test from the selector.
- **Notifications**: "not configured" (red, no "operator key missing"); SMS label drops "(Twilio)";
  "Toggle a channel…" is its own sentence.
- **Decisions**: overflow guards (`min-w-0`, `break-words`, `overflow-x-hidden`) to stop the
  intermittent right-edge cutoff on mobile.

### Verified
S&P 500 + Nasdaq 100 = **515** confirmed correct (deduped union: 502 + 101 − 88 overlap).

## Files (base)
- src/lib/web-sources/congress.ts, src/lib/web-sources/sec.ts, src/lib/market.ts,
  src/lib/db-settings.ts, src/lib/alpaca.ts
- app/ui/overlays.tsx, app/dashboard-client.tsx
- test/learned-context.test.ts, test/learned-context-sharing.test.ts

## Verification
- `npx tsc --noEmit` clean (after `npm ci`).
- `npx vitest run` — **1271/1271 pass** (incl. updated learned-context default tests).
- `npm run build` — **Compiled successfully** (full route build).
- Not browser-verified (no preview in this environment); UI correctness rests on tsc + build + careful
  review of each merged region. Recommend a quick mobile walkthrough of Settings, System Help, the
  Edit-Account modal, the Portfolio positions expander, and the Market Scan header.

## Notes / decisions
- S&P 500 + Nasdaq 100 = **515** is correct (502 + 101 − 88 overlap, deduped union). No change.
- Sharing-default flip is an explicit owner request; only fact-tier structural market facts are ever
  shared (PII excluded, risk/strategy directives never auto-shared).

## Update — merged `main` + Codex review (PR #198)
Merged `origin/main` (clean, no conflicts) so the PR became mergeable and CI could run (a conflicted
PR can't build its merge ref, so CI never starts — that was why no `verify` run appeared). Addressed
three Codex P2 review comments:
- **congress.ts** `coerceCongressTrade`: a SUPPLIED-but-future/unparseable `tradedAt` (or
  `disclosedAt`) now rejects the whole row instead of falling back to the other date — previously a
  future-dated trade could still enter under its disclosure date.
- **sec.ts** `parseForm4Xml`: a SUPPLIED-but-future/garbage `periodOfReport`/`signatureDate` now drops
  the filing instead of silently re-anchoring to today.
- **dashboard-client.tsx** banner mode: stop reading the legacy `execution-banner-hidden` key as the
  new "hidden" state (it always meant a *visible* compact banner). New `execution-banner-mode` key is
  the source of truth; legacy prefs migrate to **compact**, so upgrading users never lose the
  Test/Paper/Brokerage safety banner without explicitly choosing Hidden.
Second Codex round (P2, both date helpers): `saneIsoDate`/`saneFilingDate` used `Date.parse(iso)`,
which rolls impossible dates over to a valid timestamp (e.g. `2026-02-30` → Mar 2) and returned the
impossible original. Both now build the UTC date from the parsed components and require it to
round-trip, rejecting `2026-02-30`/`2026-04-31`/`2025-02-29`/`2026-13-01` while keeping real leap days
(`2024-02-29`). Added a regression test in `test/congress-trade-events.test.ts`.
Re-verified: tsc clean · **1351/1351** tests · build OK.

Third Codex round (5 P2s on the full re-review). Fixed:
- **formatDateRange** (dashboard): date-only ISO strings were parsed as UTC midnight then formatted in
  local time, rendering one day early in US time zones — now formats with `timeZone: "UTC"`.
- **normalizeTradeDate** (congress): `saneIsoDate`'s ±3-day timestamp skew let a near-future trade date
  (tomorrow/+3d) through; trade/disclosure calendar dates can't be future, so anything strictly after
  today is now rejected (regression test added).
- **Edit-Account env** (dashboard): leaving the API key blank ("leave blank to keep") on an existing
  account re-inferred `environment` from the blank key and could flip a PK-inferred paper account to
  live on a label-only edit; we now keep the stored environment unless a key is actually (re)entered.
Intentionally NOT changed (both are explicit owner requests, noted on the PR):
- Live Brokerage portfolio chip stays green (owner asked for it; the prominent top account-mode banner
  remains the primary real-money cue).
- The "Connect Alpaca MCP" add button stays removed (owner asked to hide the MCP option); existing
  alpaca-mcp accounts remain editable.
Re-verified: tsc clean · **1351/1351** tests · build OK.

Fourth Codex round (1 P2): the near-future tightening in round 3 fixed the **congress** path but left the
symmetric **insider** `saneFilingDate` with the ±3-day skew, so a Form 4 dated tomorrow still passed.
Applied the same strictly-after-today rejection to `saneFilingDate` (drops future/near-future/rolled-over
`periodOfReport`/`signatureDate`/`filedAt`); added a regression test in `test/web-sources-sec.test.ts`.
Re-verified: tsc clean · **1352/1352** tests · build OK.

Fifth Codex round (full re-review). Fixed:
- **Privacy (`market.ts`):** force-included holdings were leaking off-box — `scanMarket` shares
  `topCandidates` refs with App A, and holdings had been appended to that list. Now the share payload
  excludes held symbols entirely (holdings are personal account data and never leave the box); they
  still appear in the in-app candidate set so the agent can exit them.
- **Account selector (`dashboard`):** dropping the env suffix made two same-labeled accounts (e.g. two
  "Alpaca") render identical option text — a real-money footgun. Now the environment is appended ONLY
  when labels collide, so distinct labels stay uncluttered (per the owner request) but ambiguous ones
  are disambiguated.
Intentionally kept (explicit owner requests; Codex flagged the trade-off, owner can reverse):
- Live Brokerage portfolio chip stays green (top banner remains the real-money cue).
- `contributeShared` defaults ON (only fact-tier structural market facts are shared; PII excluded,
  risk/strategy directives never auto-shared) — Codex notes this opts users in without an explicit
  toggle; flagged for owner confirmation.
Re-verified: tsc clean · **1352/1352** tests · build OK.

## Follow-ups
- The Alpaca mismatch fix addresses spurious/formatting mismatches; if a genuine wrong-number is stored
  the run still surfaces the actionable message (by design). A deeper trace of where the run sources the
  account number vs. the snapshot is a possible follow-up if mismatches persist.
