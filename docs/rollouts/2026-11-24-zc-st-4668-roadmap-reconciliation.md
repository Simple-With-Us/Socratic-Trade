# 2026-11-24 — ST-4668 AG full-stack roadmap: reconciliation against main, batch plan, owner decisions

## 1. Context & Objective

Jay handed ZC session `RR` the Antigravity `KK` handoff note for the Socratic-Trade full-stack improvement effort (Waves 1-4) on Tue, Nov 24, 2026. The note described Wave 2 as paused with three open PRs and Waves 3-4 as unstarted.  Live state had moved within hours, and three audits now overlap (Antigravity Waves 1-4, Muse Code's ST-4650 sweep, and ZC's own ST-4637 to ST-4662 wave), so the first job was to reconcile every roadmap item against `main` before executing anything.  This note is that reconciliation, plus the batch plan and the decisions only the owner can make.

The source note lives in the Antigravity brain store (conversation `65e6f6e7-b852-40e4-8b45-6b04b59b26c4`) and is not tracked in this repo.

## 2. Handoff versus live state

| Item | Handoff (10:51 AM) | Live (about 8:00 PM) |
|---|---|---|
| PR #5464, ST-4664 (Wave 2A) | open, three review fixes pending | merged 3:30 PM |
| PR #5465, ST-4666 (Wave 2C) | open | merged 5:07 PM |
| PR #5466, ST-4665 (Wave 2B) | awaiting review | merged 8:41 PM |
| ST-4652 to ST-4661 | mostly in progress | all Done except ST-4655, ST-4656 and ST-4658 (Muse Code) |

The commits that closed out the Wave 2 PRs are tagged `GB-Deployer`.  ZC touched none of those branches or lanes.

## 3. Method

Six read-only scouts, one per roadmap section, verified every sub-item against `main` at `0462afcef1` (before #5466 merged) and, for the learning section, against the #5466 diff.  Nothing was built, run or edited by the scouts.

Verdicts: DONE (fully on main), PARTIAL (the remaining work is stated), NOT_STARTED (the audit claim still holds), DROPPED (landed work deliberately skipped it).

Of 140 roadmap sub-items: 25 are DONE, 28 PARTIAL, 85 NOT_STARTED, 1 DROPPED by design and 1 UNCLEAR.  Of the 115 that are not done, 39 are in flight in five ZC lanes (section 5), 52 wait on an owner decision (section 6), and 24 are queued with no decision needed.

## 4. Findings worth knowing

- **F1. PR #5465 is inert in production.**  The momentum, volatility and 20-day ADV changes read quote fields (`return20d`, `return60d`, `return126d`, `return5d`, `realizedVol20d`, `realizedVol60d`, `atrPct`, `avgVolume20d`) that appear only as optional reads in `src/lib/market.ts` and `src/lib/strategy-risk.ts`.  The only producer computes `avgVolume20d` and `atr14` for the proposal scorecard (`src/lib/strategy.ts`).  Scan ranking therefore still runs the fallback momentum and a 52-week-range volatility proxy, and the ADV cap is still 5% of same-day dollar volume.  See OD-1.
- **F2. PR #5466 flipped a read its own comments reserved for the owner.**  `listLearnedContextForDecision` now returns owner-approved private risk-tier lessons into the trading prompt, and approval-time Red Team reviews reuse Green's persisted context, which can change haircut and hold outcomes.  Both match the roadmap's intent and are merged.  See OD-2.
- **F3. The parity receipt in #5466 cannot fail.**  It compares the Green evidence pack with itself.  Tracked in ST-4678.
- **F4. A Wave 1 change pages P0.** `vix-cboe` returns 403 after the Nov 22 VIX reorder (ST-4672, claimed by Claude).

## 5. Batch plan

### In flight (ZC lanes, all children of ST-4668)

| Issue | Scope | Surface |
|---|---|---|
| ST-4669 | iOS fixes bundle: OpenRouter model availability, order row identity, shared decoder, logo cache, coach polish, small layout fixes, symbol sheet header, Home run summary | iOS |
| ST-4670 | iOS Proposals: safety-warning parity with the web card, triage filter and sort bar, risk/reward ladder, detail label wrap | iOS |
| ST-4676 | Web console P0 fixes: admin-only panels, undefined CSS tokens, guarded account switch, link and label fixes, watchlist 401, placeholder rows, orbs gate, unused deps | Web |
| ST-4677 | RAG and backend hygiene: dead RAG modules, uncalled ingest path, unretrievable fundamentals vectors, duplicate FTS rows, stale comments, retention labels | Backend |
| ST-4678 | Learning residuals after ST-4665: failover weighting before truncation, real parity receipt, horizon-matched Red efficacy, RAG lift scorecard, memory-write outbox | Backend |

### Queued, no owner decision needed

- **iOS batch 3.** Price alerts UI (P8), `TabPreferences` to `@Observable` (P1), local patch for `mobile.command` and acknowledge (P2), stage a coach draft (P11b), Swift Charts overhaul (P12), bold Lato tokens and `monospacedDigit` (P13a, P13b), scan search and `digest.overlap` (R2l).
- **Web batch 2.** Server `fields=` slice and three snapshot-independent routes (W13, also ST-4667), Orders, Watchlist and Positions twin trees (W20, also ST-4667), consent in the dashboard payload (W15), ApprovalCard link to the decision (W27).
- **Backend batch 2.** Sargable `notionalInLastMinutes` (E1d sibling; `src/lib/db-execution.ts` is an owner-merge path), universe manifest generator (A4e), audit chain-tip table (ST-4667).

### Queued behind section 6

Every item in the appendices whose last column names an OD.

## 6. Owner decisions, with a recommendation each

| ID | Decision | Recommendation |
|---|---|---|
| OD-1 | Wire the bar-derived quote fields so #5465 takes effect (F1).  Changes scan ranking and moves the ADV cap from 5% of same-day volume to 1% of 20-day ADV | Yes, from the nightly OHLC cache, in its own PR |
| OD-2 | Keep or revert the owner-reserved reads #5466 enabled (F2) | Keep; ST-4678 grows a revert on request |
| OD-3 | Risk and scoring defaults (E2b, E2d, E2e, E2g, E2i, E2j, E2k, E2l, E2m, D6b) | Approve the tighten-only subset in one PR (entry drift 3%, proposal expiry 240 min, symbol exposure 15%, sector caps 30%, earnings blackout on, backtest thresholds with auto-apply off); decide separately on trailing stops by default, marketable limit entries by default, a VIX severity-to-size multiplier, Thompson-sampling routing, alpha grading with short calibration, and strict fundamentals point-in-time with auto-apply |
| OD-4 | Retention caps for the 15 observability tables that still have none (E1c) | Cap operational telemetry only (provider dispatch and usage outbox, ingest task attempts, notification delivery events); keep audit events, LLM and RAG usage, strategy runs, portfolio snapshots, headline first-seen and the learning tables forever |
| OD-5 | Transcript and summary sources in BM25 lexical recall, and the write-class flip (A4d, A4g) | Leave restricted unless the ROIC and EarningsCalls licenses allow it |
| OD-6 | Bump `embed_rev` and re-embed the corpus so the structured headers reach existing vectors (A1) | Yes, off hours, with the daily embed cap raised for the run |
| OD-7 | Prune the operational vector index (Form 4 XML vectors, empty-ticker 13F vectors, superseded generations), weekly soft-archive, decay weighting on; continue the Pinecone removal (A2, A4b, C1, C2) | Yes, in three steps with receipts: dry-run counts, live junk delete, then weekly soft-archive |
| OD-8 | Spend-increasing retrieval and grading: catalyst and regime episodic lanes (A4h), adversarial Red query (D5d), hypothesis grading (D6a), Red Team toolbelt and rebuttal turn (E3a, E3b), candidate pool flag (D6c) | Defer until the ST-4678 lift scorecard shows RAG is paying |
| OD-9 | Learning-to-trading seams: hard constraints from chat memory (D4a), accepted framework proposals applying (D4b), Red vetoes getting decision rows (D5c) | Land the first two in propose mode with an explicit override; yes to veto decision rows, deduped against skipped counterfactuals |
| OD-10a | iOS 18 extensions: App Group, push categories and Notification Service Extension, Live Activities, widgets, Control Center and Siri (P14a to P14f) | iPad split view ships now; the rest waits on the Developer Portal steps |
| OD-10b | Light, dark, system theme toggle (P13g) | Keep light only |
| OD-10c | Full-ticket confirmation sheet for approvals (R1f) | Show the full ticket and keep the typed phrase for live; a simple confirm for paper |
| OD-10d | New phone trading actions: Close and Trim from a position, Replace at Market on a working order, universe widening from the phone (R2f, R2g, P9) | Yes to Close, Trim and Replace at Market through the existing order path with the same confirmation; no to universe widening from the phone |
| OD-10e | iOS design defaults: Home equity dedupe and Today's P&L (R2a), stop pill on every tab (R2d), settings split (R2e), Insights as an Intelligence hub (R2m), symbol sheet chart (R2j), toasts and skeletons (R2o), collapsed cards and side-by-side debate (R1a, R1d) | Proceed on defaults unless vetoed: Equity stays on the Account card with a broker-verified Today tile; a confirmed stop pill on every tab; settings as pushed subpages; Insights renamed with a read-only learning inbox first; toasts for non-money alerts only |
| OD-11 | Web: bare R hotkey (W11), account-switch reload removal (W16), brand-row hold (W17), one toast system (W23), Decisions in nav and framework proposals in Lessons (W25), orphaned skeletons and AllocationCard (W14, W28), Human Counterfactual scorecard and run stepper (W26, W29), Sign in call to action on the welcome page (W34), chart interactivity scope (W30, W31, W33) | Hotkeys need a modifier; remove the reload behind a guard test; hold the brand row 1s; sonner wins; add Decisions to nav; add the Sign in call to action; scorecard and stepper after the data is defined |

## 7. Decisions & trade-offs

- Items a scout flagged as a design-taste call are not held for the owner: they proceed on the defaults in OD-10e and OD-11, which can be vetoed in flight.  Only money-path behavior, data retention, licensing, spend and Apple Developer Portal actions are held.
- Scouts were read-only and expensive: a general-purpose scout cost 15 to 18 million tokens for 73 to 99 tool calls, against 3.5 to 5 million for a read-only Explore scout.  Implementation workers get tighter briefs and run only lint, type-check and targeted tests; the full gate runs once per lane, serialized, because this server also hosts production.

## 8. Verification state

No code changed in this note.  Verification was six read-only passes over `main` at `0462afcef1` plus `git log`, `git show --stat` and Linear reads for the state in section 2. The F1 grep was re-run by the lead on `origin/main` and shows the fields only as type declarations and reads.

## 9. Next steps & blockers

1. Land the five in-flight batches (ST-4669, ST-4670, ST-4676, ST-4677, ST-4678).
2. On OD-1, open the producers PR.  On OD-3, open the tighten-only defaults PR.
3. Start the queued no-decision batches as lanes free up.
4. Blockers: every OD in section 6.

## Appendix A: Wave 2A, 2B, 2C (RAG, retrieval, safe pruning)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| A1 | PARTIAL | `embed_rev` unchanged, so the existing corpus is not re-embedded | OD-6 |
| A2 | NOT_STARTED | `parent_text` duplicated per child vector; Pinecone cap on Qdrant writes; Pinecone slices 1-6 | OD-7 |
| A3 | DONE | none | |
| A4a | DONE | already-embedded Form 4 XML vectors remain until a prune | OD-7 |
| A4b | NOT_STARTED | 13F vectors embedded with an empty ticker | OD-7 |
| A4c | NOT_STARTED | uncalled `ingestRoicFinancialsToRag`; unretrievable fundamentals vectors | ST-4677 |
| A4d | PARTIAL | double FTS mirror (ST-4677); three transcript writes under the default write class | ST-4677, OD-5 |
| A4e | NOT_STARTED | manifest generator emits sentinel rows; needs a live run | backend batch 2 |
| A4f | DONE | none | |
| A4g | DROPPED | transcripts kept out of BM25 for licensed-source entitlement | OD-5 |
| A4h | NOT_STARTED | catalyst and regime episodic lanes | OD-8 |
| A4i | NOT_STARTED | three dead RAG modules | ST-4677 |
| B1 | DONE | none | |
| B2 | DONE | none | |
| B3 | DONE | landed by #5466 with budgets of 6,000, 4,500 and 2,000 characters | |
| C1 | PARTIAL | decay weighting sits behind an off-by-default flag; `blendedScore` and soft-archive have zero callers | OD-7 |
| C2 | NOT_STARTED | scheduler reconcile is dry-run with a 50k cap; Pinecone ticks remain | OD-7 |

## Appendix B: Wave 2D (learning plumbing and Red Team parity)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| D1 | DONE | landed by #5466; it enabled an owner-reserved read | OD-2 |
| D2 | PARTIAL | failover path weights after truncation; dead statement | ST-4678 |
| D3a | DONE | stale comment only | ST-4677 |
| D3b | NOT_STARTED | no durable retry for fail-open memory writes | ST-4678 |
| D4a | NOT_STARTED | chat-stated hard constraints never reach policy, strategy or execution | OD-9 |
| D4b | NOT_STARTED | accepted framework proposals change nothing | OD-9 |
| D4c | DONE | none | |
| D5a | PARTIAL | efficacy passed to Red is not horizon-matched | ST-4678 |
| D5b | PARTIAL | parity receipt compares Green with itself | ST-4678, OD-2 |
| D5c | NOT_STARTED | Red vetoes write no decision row | OD-9 |
| D5d | NOT_STARTED | one static retrieval query; no adversarial Red query | OD-8 |
| D6a | NOT_STARTED | no hypothesis fields and no mechanism grading | OD-8 |
| D6b | NOT_STARTED | raw grading default; calibration is long-only | OD-3 |
| D6c | UNCLEAR | candidate pool flag is off; contradiction detection does not exist | OD-8 |
| D6d | NOT_STARTED | no RAG versus No-RAG lift scorecard | ST-4678 |

## Appendix C: Wave 3A and 4.4 (iOS perf, bug fixes, extensions)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| P1 | PARTIAL | `TabPreferences` is still `ObservableObject` | iOS batch 3 |
| P2 | PARTIAL | no local patch for `mobile.command` and acknowledge | iOS batch 3 |
| P3 | DONE | none | |
| P4 | PARTIAL | one shared decoder | ST-4669 |
| P5 | DONE | none | |
| P6 | NOT_STARTED | duplicate order row identity | ST-4669 |
| P7 | NOT_STARTED | logo image cache | ST-4669 |
| P8 | NOT_STARTED | price alerts UI (the server commands already exist) | iOS batch 3 |
| P9 | NOT_STARTED | universe widening from the phone | OD-10d |
| P10 | DONE | `socratic.trade` AASA in production was not verifiable from the server | OD-10a |
| P11a | NOT_STARTED | OpenRouter models disabled for OpenRouter-only owners | ST-4669 |
| P11b | NOT_STARTED | stage a coach draft as a proposal (approval stays separate) | iOS batch 3 |
| P11c | NOT_STARTED | no dismiss on the coach draft card | ST-4669 |
| P11d | NOT_STARTED | citations are not links | ST-4669 |
| P11e | PARTIAL | chat-wide text selection and keyboard dismissal | ST-4669 |
| P12 | NOT_STARTED | Swift Charts overhaul | iOS batch 3 |
| P13a | NOT_STARTED | bold Lato tokens | iOS batch 3 |
| P13b | NOT_STARTED | `monospacedDigit` sweep | iOS batch 3 |
| P13c | NOT_STARTED | fixed 58pt label column wraps | ST-4670 |
| P13d | NOT_STARTED | legal consent sheet does not scroll | ST-4669 |
| P13e | NOT_STARTED | audit log is not grouped by day | ST-4669 |
| P13f | NOT_STARTED | dead `ControlBriefCard.swift` | ST-4669 |
| P13g | NOT_STARTED | theme toggle versus the light-only decision | OD-10b |
| P14a | NOT_STARTED | actionable push categories, service extension, badge sync | OD-10a |
| P14b | NOT_STARTED | Live Activities and Dynamic Island | OD-10a |
| P14c | NOT_STARTED | WidgetKit suite | OD-10a |
| P14d | NOT_STARTED | Control Center widget and App Intents | OD-10a |
| P14e | NOT_STARTED | iPad split panes (needs no Portal step) | iOS batch 4 |
| P14f | absent by design | App Group removed 2026-09-30 | OD-10a |

## Appendix D: Wave 3B (iOS trader workflow redesigns)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| R1a | NOT_STARTED | compact card with expandable receipt | iOS batch 4, OD-10e |
| R1b | PARTIAL | risk/reward ladder and drift colouring | ST-4670 |
| R1c | PARTIAL | stopPlan none, holdReason, humanReviewReasons, dataAdjustments, wash-sale note, exit P&L, expiry countdown | ST-4670 |
| R1d | PARTIAL | side-by-side debate and scorecard; citations need a wire field | iOS batch 4, OD-10e |
| R1e | NOT_STARTED | triage filter and sort bar | ST-4670 |
| R1f | PARTIAL | typed-confirmation alert shows no full ticket; paper has no confirm | OD-10c |
| R2a | NOT_STARTED | equity and open P&L shown on three Home cards | iOS batch 4, OD-10e |
| R2b | DONE | none | |
| R2c | PARTIAL | latest-run summary card on Home | ST-4669 |
| R2d | NOT_STARTED | stop control only on Home | iOS batch 4, OD-10e |
| R2e | NOT_STARTED | one 11-section settings form | iOS batch 4, OD-10e |
| R2f | NOT_STARTED | `PositionRow` upgrades; Close and Trim need new commands | OD-10d |
| R2g | NOT_STARTED | Replace at Market and stale badges; needs a new command | OD-10d |
| R2h | NOT_STARTED | live watchlist prices | iOS batch 4 |
| R2i | PARTIAL | symbol header card is not on top | ST-4669 |
| R2j | NOT_STARTED | interactive history chart with level marks | OD-10e |
| R2k | NOT_STARTED | star, alert and coach actions in the symbol sheet | iOS batch 4 |
| R2l | NOT_STARTED | searchable scan, sort chips, `digest.overlap` | iOS batch 3 |
| R2m | NOT_STARTED | Insights as an Intelligence hub | iOS batch 4, OD-10e |
| R2n | PARTIAL | by thesis, by regime, Red efficacy, signal health, tax summary | OD-10e |
| R2o | NOT_STARTED | blocking alerts; no skeletons | iOS batch 4, OD-10e |
| R2p | DONE | none | |

## Appendix E: Wave 3C (web console)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| W1 | NOT_STARTED | admin-only panels fire 403 for non-admins | ST-4676 |
| W2 | NOT_STARTED | 14 uses of 5 undefined CSS tokens | ST-4676 |
| W3 | NOT_STARTED | blur defect in the fallback model select; not reproduced | needs a repro |
| W4 | NOT_STARTED | placeholder rows in the alert center | ST-4676 |
| W5 | NOT_STARTED | symbol drawer stays open on navigation | ST-4676 |
| W6 | NOT_STARTED | peer-account switch has no guard or refresh | ST-4676 |
| W7 | NOT_STARTED | review deep link lacks the proposal id | ST-4676 |
| W8 | NOT_STARTED | budget block points at the wrong page | ST-4676 |
| W9 | NOT_STARTED | stale-limit hint and Orders pointer | ST-4676 |
| W10 | NOT_STARTED | `all_openings` shows as legacy trigger | ST-4676 |
| W11 | NOT_STARTED | bare R runs Run Once | OD-11 |
| W12 | DONE | none | |
| W13 | PARTIAL | server `fields=` slice and three snapshot-independent routes | web batch 2, ST-4667 |
| W14 | NOT_STARTED | orphaned skeletons | OD-11 |
| W15 | NOT_STARTED | consent not in the dashboard payload | web batch 2 |
| W16 | NOT_STARTED | account switch reloads the page | OD-11 |
| W17 | NOT_STARTED | 3s brand-row hold | OD-11 |
| W18 | PARTIAL | tooltip portals to `document.body`; `motion` still a dependency | ST-4676, ST-4667 |
| W19 | NOT_STARTED | body orbs animate on every page | ST-4676 |
| W20 | PARTIAL | Orders, Watchlist and Positions twin trees | web batch 2, ST-4667 |
| W21 | DONE | none | |
| W22 | NOT_STARTED | unused `react-resizable-panels` | ST-4676 |
| W23 | NOT_STARTED | two toast systems | OD-11 |
| W24 | NOT_STARTED | watchlist 401 does not redirect | ST-4676 |
| W25 | NOT_STARTED | Decisions not in nav; framework proposals Home-only | OD-11 |
| W26 | NOT_STARTED | run stepper needs server step data | OD-11 |
| W27 | PARTIAL | raw chunk expander (ST-4676); ApprovalCard link needs a lookup | web batch 2 |
| W28 | NOT_STARTED | orphaned `AllocationCard` | OD-11 |
| W29 | NOT_STARTED | scorecards on Results; human counterfactual undefined | OD-11 |
| W30 | PARTIAL | chart interactivity and drawdown shading | OD-11 |
| W31 | PARTIAL | filter chips on Scan, Guardrails, Positions | OD-11 |
| W32 | PARTIAL | one `select multiple` | ST-4676 |
| W33 | NOT_STARTED | flat notification checkbox grid | OD-11 |
| W34 | NOT_STARTED | no Sign in call to action on the welcome page | OD-11 |

## Appendix F: Wave 4 (backend hot paths, factor and exit alpha, agentic debate)

| id | Verdict | Remaining | Tracked in |
|---|---|---|---|
| E1a | DONE | none | |
| E1b | DONE | none | |
| E1c | PARTIAL | `api_health_log` done; 15 observability tables still have no retention | OD-4 |
| E1d | DONE | sibling `notionalInLastMinutes` is still non-sargable (owner-merge file) | backend batch 2 |
| E1e | DONE | none | |
| E1f | DONE | none | |
| E1g | DONE | none | |
| E1h | DONE | none | |
| E2a | PARTIAL | multi-horizon momentum and realized vol read fields nothing writes | OD-1 |
| E2b | NOT_STARTED | trailing stops off; no breakeven ratchet | OD-3 |
| E2c | DONE | none | |
| E2d | NOT_STARTED | marketable limit entries off | OD-3 |
| E2e | NOT_STARTED | entry drift 10%, proposal expiry 48h | OD-3 |
| E2f | PARTIAL | 20-day ADV cap inert | OD-1 |
| E2g | NOT_STARTED | symbol exposure 25%, no sector caps | OD-3 |
| E2h | DONE | none (path is opt-in) | |
| E2i | NOT_STARTED | hard VIX step; no severity multiplier | OD-3 |
| E2j | PARTIAL | earnings blackout still opt-in | OD-3 |
| E2k | NOT_STARTED | representation-balanced rotation only | OD-3 |
| E2l | NOT_STARTED | overlapping 5d compounding; loose OOS gate | OD-3 |
| E2m | NOT_STARTED | strict fundamentals point-in-time off; auto-apply off | OD-3 |
| E3a | NOT_STARTED | no Red Team toolbelt | OD-8 |
| E3b | NOT_STARTED | no rebuttal step | OD-8 |
