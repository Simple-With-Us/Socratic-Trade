# Cross-Platform Quality Roadmap

**Date:** 2026-07-12

**Status:** planned; no product code is implemented by this document

**Scope:** native iOS, responsive web/PWA, backend/application framework, trading
framework, data, security, operations, testing, and release engineering

## Relationship to the capability program

This is a quality, dependency, and release-gate addendum to
`docs/reviews/2026-07-12-capability-program-plan.md`. It does not replace that
program, `docs/trading-framework.md`, `docs/capability-trading-roadmap.md`, or the
phase design docs. The capability program says what to add; this document defines
the platform seams and proof required to add it safely across every client.

The canonical app-audit inventory remains A01-A34 in `docs/EFFORT-LOG.md`. Its
current truth is 8 resolved/live, 13 partial/open, and 13 unresolved. The three
remaining P0 findings—A21, A27, and A28—are release blockers for new money-path
capabilities.

## Product boundaries

There are three client surfaces, but only two durable products:

1. `/console` is the canonical responsive desktop/mobile web application.
2. Native iOS is a focused control and monitoring client over the same versioned
   contracts.
3. `/mobile` remains a compatibility/PWA control surface until native iOS and the
   responsive console prove auth, STOP, approvals, freshness, and account switching.
   It should eventually share its control feature with `/console`, not become a third
   independently designed application.

Backend strategy, broker credentials, provider calls, LLM calls, and order placement
remain server-side. Clients never hold broker/provider credentials, run strategy
logic, or queue offline trading mutations.

## Program invariants

- Account identity is immutable within a command or strategy run. No money-path code
  may resolve “the active account” after work begins.
- STOP, cancellation, reconciliation, and protective maintenance remain available
  when optional telemetry, market data, or broker admission checks fail.
- Every mutation is idempotent and exposes queued, running, terminal, uncertain, and
  retryable truth. Optimistic UI never invents completion.
- Broker paper and live environments are both real connected accounts. There is no
  local fake-fill product path.
- New trading capabilities require deployment flag, per-account opt-in, and fresh
  broker-confirmed capability. Unknown or stale capability means unavailable.
- Migrations are additive. `undefined` preserves current behavior. Roll back by flag
  before code, without disabling reconciliation or protective maintenance.
- Accessibility, privacy, observability, and recovery are release gates, not polish.

## Delivery waves

### Wave 0 — close trust and control blockers

Do this before enabling shorts/leverage/options/Kalshi/eToro execution.

#### X0.1 Safety maintenance coordinator — P0

Close A21 and the reliability portion of A13. Run fill reconciliation, stale
placing-intent recovery, stale-exit handling, synthetic/broker stops, and expiry
before broker-health strategy admission. Add deadlines to every broker read and a
whole-tick singleflight guard.

Acceptance:

- Protective maintenance starts on every tick even when strategy admission fails.
- Every broker call has a deadline and overlapping ticks cannot duplicate work.
- Every stale placing intent becomes reconciled, terminally rejected, or visibly
  uncertain; none is silently discarded.

#### X0.2 Draining fence — P0

Close A27. Account deletion remains `active -> draining -> purged`. Snapshot the
account ID and revision in the run context, then re-read and reject before intent
claim and immediately before broker placement.

Acceptance: forced races across deletion, approval, scheduled run, and mobile command
produce zero broker placements after draining begins.

#### X0.3 Exit replacement state machine — P0

Close A28 with explicit `cancel_requested -> cancel_confirmed ->
replacement_submitted -> replacement_confirmed` states. `pending_cancel` is never
counted as success; retries reuse an idempotency key.

Acceptance: response-loss and retry tests produce at most one replacement order per
idempotency key, and unresolved broker truth remains visible.

#### X0.4 Account-bound command contract — P0

Every account-scoped mobile/web command carries immutable `connectedAccountId` and,
where relevant, account/policy revision. The server verifies ownership and non-draining
state at enqueue and execution. Complete A20 with policy compare-and-swap; stale writes
return `409` plus the current revision.

Acceptance: interleaving two accounts and two clients cannot retarget run/start/stop,
approval, policy, prompt, or deletion work.

#### X0.5 Preemptive STOP and control bootstrap — P0

STOP cannot wait behind a long `run_once` or the full telemetry snapshot. Add a small
DB-only control read model—identity, account list/current account, system state,
authority, and pending command count—and a priority control path. Running strategy work
must observe halt before any later placement checkpoint.

Acceptance:

- Control bootstrap p95 is at most 750 ms and at most 30 KB, with zero market, news,
  macro, or broker telemetry calls.
- STOP is visible and operable within 1.5 seconds on desktop, mobile web, and iOS.
- During a deliberately blocked two-minute run, STOP persists halted within one second
  and no order is placed after the halt checkpoint.

#### X0.6 Native auth contract — P0 for iOS release

Converge the active server-auth and iOS lanes on one exact versioned path. Use
`ASWebAuthenticationSession`, PKCE S256, unpredictable state bound to the one-use code,
exact callback validation, scoped rotating device sessions, revocation, and replay
protection. Store only the device secret in Keychain using a ThisDeviceOnly class; do
not persist plaintext tokens in SQLite or logs.

Acceptance: wrong state/verifier/callback, replay, expiry, revocation, and concurrent
exchange all fail. Relaunch restores and validates once; any `401`/`403` synchronously
signs out. Sign-out revokes the server session and APNs registration before local clear.

### Wave 1 — one versioned client platform

#### X1.1 Contracts and fixtures

Create server-owned, versioned DTOs and checked-in JSON fixtures under
`src/contracts/`. TypeScript routes and Swift models must both pass conformance tests.
Use a stable error envelope with code, retryability, trace ID, and field details.

Initial boundaries:

```text
src/contracts/
  control-v1.ts
  mobile-v1.ts
  console/*.ts

src/lib/read-models/
  control.ts
  home.ts
  approvals.ts
  orders.ts
  settings.ts
  mobile.ts

src/lib/mobile/
  schema.ts
  auth.ts
  commands.ts
  projection.ts
  events.ts
  push.ts
```

Thin HTTP handlers authenticate, validate, call an application service, and map its
result. They do not assemble dashboard state or implement strategy logic.

#### X1.2 Realtime and command lifecycle

SSE events carry stable event IDs and named resource invalidations. Clients resume by
cursor, debounce bursts, expose stream health, and begin jittered fallback polling
within 20 seconds of sustained failure. Normal stream end and error use the same
recovery path. Only one refresh per resource may be in flight.

Commands use one lifecycle across web and iOS: submitted, queued, running, succeeded,
failed, cancelled, uncertain. Stale running commands use leases and restart recovery.

#### X1.3 Mobile API v2 read models

Replace the monolithic mobile snapshot with a fast summary plus paginated proposals,
activity, and markets resources. Each response carries schema version, `generatedAt`,
section freshness/errors, cursor, and trace ID. The server provides watchlist quote
summaries; the phone never calls market-data providers directly.

Budgets: summary at most 75 KB raw; other route read models at most 150 KB raw.

### Wave 2 — complete the native iOS application

The active Claude iOS foundation remains the implementation owner. The target stays
iOS 17+ while building with the current App Store-required SDK/toolchain. Do not adopt
iOS-26-only visual APIs while iOS 17 remains supported.

#### X2.1 State and navigation

- One `@MainActor`, Observation-based `@Observable` app store owns auth, account,
  snapshot freshness, and command truth.
- One in-flight snapshot; trailing refresh after event bursts; foreground/online
  refresh; polling fallback; explicit last-good stale state.
- Independent `NavigationStack` path per tab, central typed router, and reset on
  logout/account change.
- Item-driven sheets and confirmation flows; no parallel Boolean sheet state.

Recommended package boundaries after the foundation lands:

```text
SocraticTradeDomain
SocraticTradeTransport
SocraticTradeAuth
SocraticTradeState
SocraticTradeTestSupport
App target: AppShell, DesignSystem, and five feature folders
```

Do not create one package per screen. Keep AuthenticationServices, UserNotifications,
and other system adapters at the app boundary where practical.

#### X2.2 Five release-complete tabs

- Home: account/environment, run state, equity/P&L, positions, scheduler, market
  session, prominent STOP.
- Proposals: evidence, Green/Red attribution including failed/not-run states, policy
  reasons, exact server result, preference-controlled live confirmation.
- Activity: truthful orders, fills, and commands with pagination.
- Markets: watchlist, server-produced quote summaries, and alerts.
- Settings: account switch, policy/guardrail summary, device sessions, sign-out, and
  account deletion.

No placeholder copy remains. Every mutation stays visibly bound to its originating
account through terminal result.

#### X2.3 Native quality and release

- App/unit/XCUITest targets, deterministic clocks/transports, simulator UI smoke, and
  project-regeneration diff gate.
- Keychain restore, network transition, stale/offline, deep-link, VoiceOver, Dynamic
  Type, Reduce Motion, and light/dark coverage.
- App icon/assets, entitlements, `PrivacyInfo.xcprivacy`, localized string resources,
  App Store privacy answers, signing outside source, and TestFlight physical-device QA.
- APNs later in this wave: token-based provider, durable outbox, disable on sign-out,
  notification preferences, opaque IDs in pushes, detail fetched after unlock.

Release gate: `swift test`, generic-device build, simulator build/test, XCUITest smoke,
zero placeholder screens, zero open P0s, and the production backend contract deployed
and verified before TestFlight money-path QA.

### Wave 3 — responsive web and PWA excellence

#### X3.1 Route-specific loading

Replace all-route dependence on `/api/dashboard`. Render server initial data and the
control bootstrap first, stream independent panels with Suspense, then revalidate from
a centralized client resource layer. Settings must not wait on broker/macro/news.
Use per-request cache deduplication for auth/DB work and ETags/resource versions for
conditional reads.

Close audit A04 and A30: named heartbeat, explicit EventSource health, fallback polling,
age-derived staleness, honest “still loading” state, screen-reader status, and retry.

#### X3.2 Responsive information architecture

- `/console` is canonical at desktop, tablet, and phone widths.
- Framework/Mandates remains account-scoped; Settings remains global/browser/operator.
- Extract a shared mobile control feature for `/console` and `/mobile`. Change the PWA
  start URL only after parity is proven.
- Keep one brand core with console and marketing renderers. Share semantic tokens and
  headless interaction primitives; do not force a full primitive or CSS rewrite.

#### X3.3 Accessibility and data-loss prevention

Close A31-A34 as small semantic PRs: described keyboard tooltips, a real dialog/focus
trap and combobox command palette, durable per-account/page draft restoration with
back/forward tests, accessible names, and correct radio/tab/switch/pressed semantics.

Gate at 320 CSS px and 200% zoom, 44x44 CSS px touch targets, no body horizontal
overflow, keyboard completion of every control flow, and zero critical/serious axe
findings. Manually verify focus order and announcement truth.

#### X3.4 Performance and bundle health

- Measure Core Web Vitals by route/device/theme: p75 LCP at most 2.5 s, INP at most
  200 ms, CLS at most 0.1.
- Initial JS budgets: mobile at most 200 KB gzip; console shell plus active page at most
  300 KB gzip. Any increase over 10 KB needs a receipt.
- Lazy-load charts, drawers, and markdown; remove animation code from hot primitives;
  measure package-import changes before adopting them.
- Split the Framework page, console chrome, and mobile client into feature packages
  after the read-model seams exist.

### Wave 4 — backend/framework modularity and reliability

Use a strangler migration with forwarding exports; do not rewrite the backend.

```text
src/domain/       pure money, instruments, lifecycle, policy, account invariants
src/application/  runs, safety maintenance, placement, reconciliation, mobile, learning
src/ports/        repositories, clocks, LLM, data providers, broker capabilities
src/adapters/     SQLite, brokers, event markets, LLMs, notifications
src/workers/      scheduler, durable jobs, streams
app/api/          authentication, validation, HTTP mapping
```

#### X4.1 Immutable run context and accounting

Close A23/A24 with immutable `{userId, connectedAccountId, accountNumber, broker,
environment, policyRevision}` through Green Team, Red Team, postmortem, placement,
reconciliation, notification, and audit. Close A29 by selecting newest bounded rows in
SQL and restoring chronological order for FIFO replay. Give Green and Red the same
shared evidence digest, including RAG and learned context.

#### X4.2 Durable ingress and endpoint trust

- Close A07 with a transactional inbound inbox: claim event ID, apply mutation, commit
  processed state together. Advance SSE cursors only after durable apply.
- Close A08/A09 with streaming byte limits, bounded batch cardinality, trusted-proxy IP
  handling, and exact auth exemptions.
- Close A12/A14 with canonical broker host allowlists, HTTPS and DNS/redirect
  revalidation for custom endpoints, and transactional/compensated onboarding.

#### X4.3 Health, recovery, and observability

Separate liveness, process readiness, and per-account execution readiness. Add a
transactional SQLite write probe and report storage observation failure as unknown.
Run a scratch Litestream/R2 restore drill and verify `PRAGMA integrity_check`.

Every request, run, command, broker call, LLM receipt, order intent, and notification
shares a trace/correlation ID. Record section latency, payload size, snapshot age, SSE
outage duration, fallback polls, overlapping requests, broker deadline, and scheduler
tick freshness.

Targets: scheduler tick freshness under 90 seconds; measured restore RPO at most five
minutes and RTO at most 30 minutes unless the drill proves a tighter operational target.

#### X4.4 Broker capability ports

Keep asset semantics distinct:

- `BrokerAccountReader`
- `EquityExecutionGateway`
- `OptionExecutionGateway`
- `EventContractGateway`
- `BrokerMarketDataGateway`

Do not widen equity `OrderSide` for option or event-contract intent. Options retain
BTO/STC/STO/BTC semantics; Kalshi retains buy/sell x yes/no semantics.

### Wave 5 — measured trading and learning improvements

After Waves 0-4 gates:

1. Read-only broker margin/capability telemetry.
2. Short buying-power correctness and verified short lifecycle.
3. Per-account opt-in leverage with NAV caps primary and margin alerts.
4. Tradier-first option instrument/intent model, then single-leg sandbox execution;
   covered writing before naked or multi-leg strategies.
5. Kalshi K1 public evidence first; trading only after the order-model memo, owner
   onboarding, demo verification, and event-sleeve policy.
6. eToro only after owner API-access and authenticated schema probes.
7. Live slippage telemetry before any execution-buffer auto-tuning.

Improve the learning framework with execution-cost-aware counterfactuals, out-of-sample
and holdout evaluation, regime drift/calibration monitoring, provider provenance and
quality SLOs, model-evaluation fixtures, and explicit LLM cost ceilings. Never tune from
an unrepresentative or unbounded live sample.

## Test matrix

Every money-path package adds deterministic fault tests at intent claim, broker response
loss, fill write, cancel/replace, lease loss, DB busy, process restart, and account
draining. Property/replay tests cover every state transition and all four equity sides.

Web matrix:

- Chromium, Firefox, and WebKit.
- Desktop 1440 px, iPhone, Pixel, and 320 px at 200% zoom.
- Light/dark, reduced motion, forced colors, offline, slow network, and SSE blocked.
- Independent failure/delay of every read-model upstream.
- Accessibility plus visual regression for chrome, settings, approvals, orders, sheets,
  and control surfaces.

iOS matrix:

- Pure Swift DTO/auth/retry/SSE/store/command-reducer tests.
- Backend auth replay, token scope, two-account race, STOP preemption, command lease,
  event privacy, and push ownership tests.
- XCUITest for signed-out launch, auth, five tabs, account switch, STOP during run,
  approve/reject, stale recovery, revoke/sign-out, and deletion.
- Physical TestFlight verification of AuthenticationServices, Keychain, APNs,
  foreground/background, and network transitions.

Release matrix:

- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`, Playwright, and
  gitleaks.
- Representative production-era SQLite migration and scratch restore.
- Recorded broker fixtures and sandbox integration where supported.
- Adversarial review for every money-path change.
- Production health and exact-revision verification after auto-deploy.

## Runtime policy

Keep Node 24 as the required local, CI, Nixpacks, and production runtime. Node 26 is a
non-blocking canary until it reaches LTS and stays green through clean `npm ci`, native
`better-sqlite3` load, the complete gates above, Playwright, and a Coolify-equivalent
boot/deploy rehearsal. Promote it in one coordinated package that changes `.nvmrc`, CI,
local tooling, and production together; never repair a mixed-ABI install by changing the
production runtime ad hoc.

## Deferred deliberately

- Node 26 production before LTS and canary proof.
- Whole-backend rewrite, Postgres/Kafka, or multi-instance architecture.
- Persistent offline caching of private account data or queued offline mutations.
- Full design-system merge or `console.css` rewrite.
- `/mobile` retirement before native and responsive-console parity.
- iPad-specific UI, Mac Catalyst, watchOS, visionOS, widgets, and Live Activities.
- Siri/App Intents for trading mutations; read-only status may be reconsidered later.
- Certificate pinning, jailbreak detection, or App Attest without threat evidence.
- Multi-leg/naked options before single-leg lifecycle and accounting proof.
- Kalshi/eToro execution without their explicit external-access gates.
- Raw broker MCP write tools in chat.

## Program scorecard

The roadmap is working only when the measured system improves:

- Zero cross-account command, prompt, policy, audit, or placement regressions.
- Zero post-draining placements and at most one broker order per idempotency key.
- STOP persistence under one second and control availability under optional-upstream
  failure.
- Web performance and accessibility targets above sustained at p75 by device class.
- iOS crash-free sessions at least 99.8%, auth completion at least 95%, and SSE recovery
  p95 under five seconds after the native baseline exists.
- 100% of money-path lifecycle states covered by property/replay fixtures.
- Every production release has exact-revision, DB-write, scheduler, and backup/restore
  evidence.

## Primary standards and platform references

- Node production release policy and schedule:
  <https://nodejs.org/en/about/previous-releases> and
  <https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule?pubDate=20260311>
- Apple submission SDK requirements:
  <https://developer.apple.com/news/upcoming-requirements/?id=02032026a>
- Apple privacy manifests:
  <https://developer.apple.com/documentation/bundleresources/privacy-manifest-files>
- SwiftUI Observation and navigation:
  <https://developer.apple.com/documentation/SwiftUI/Migrating-from-the-observable-object-protocol-to-the-observable-macro>
  and <https://developer.apple.com/documentation/swiftui/understanding-the-navigation-stack>
- WCAG 2.2: <https://www.w3.org/TR/WCAG22/>
- Core Web Vitals thresholds: <https://web.dev/articles/vitals>

## Ownership and coordination

- Claude's `claude/ios-foundation` lane owns the active native foundation.
- Claude's mobile-auth contract lane owns its current server-auth implementation.
- Claude's capability program remains the parent for shorts/leverage, options, Kalshi,
  eToro, and framework package trains.
- The A01-A34 effort rows remain the issue source of truth. Implementers claim a
  source-disjoint package in both effort boards and post to `#agent-sync` before edits.
- If an implementation reveals a dependency conflict, correct this roadmap and the
  effort row; do not silently work around another lane's claim.
