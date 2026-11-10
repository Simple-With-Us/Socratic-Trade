# Console — a ground-up trading UI (`/console`)

A complete, greenfield interface for the agentic trading platform, built with
**zero reuse of the existing dashboard UI** (`app/dashboard-client.tsx`,
`app/ui/**`, `app/mobile/**` were deliberately never read or imported). It
talks to the same real backend: one polled `GET /api/dashboard` snapshot plus
the existing mutation endpoints.

## Design synthesis

The console is one coherent design synthesized from three *blind* design
studies (each produced from the capability inventory alone, with no knowledge
of the existing UI):

- **Steadyhand** (novice-first)
- **TradeDeck** (operator-first)
- **Ledgerline** (explainability-first)

### The convergent spine (all three independently arrived at these — adopted wholesale)

- **Word-first account reality without alarm fatigue.** No-account and broker
  paper states get explicit ambient banners; ordinary brokerage accounts are
  treated as the normal trading state, with typed broker confirmations on
  risk-increasing actions instead of a red viewport frame.
- **Account scope always visible** and switchable from the chrome; every
  account row and every proposal repeats its own reality word.
- **Approvals as the badge destination** — the one place the human is
  load-bearing, one keystroke/tap away.
- **One-click STOP that never sells**, with the honest sentence about
  app-managed synthetic stops pausing while broker-held brackets keep resting,
  and **Exit-only as the middle verb** ("what the circuit breakers choose"; wire id stays `close_only`).
- **Asymmetric friction**: stopping/tightening/rejecting is one tap;
  starting brokerage automation / Autopilot / wind-down / loosening brokerage
  constraints / broker approval costs a typed phrase (paste disabled — the
  words are the consent).
- **Decision receipts** (approval cards carry evidence, the adversarial
  verdict, gate reasons, since-proposed counterfactual) and **run forensics**
  (Activity → Runs expands to each run's persisted proposals and reasons).
- **Per-position protection status** derived honestly from the snapshot
  (broker stop order resting / app-managed stop that pauses when stopped / —).
- **Narrated automatic transitions** — breaker trips, halted refusals,
  `placing_failed` reconciliation, boot interlock — as placed notices, not
  silence.
- **Freshness strip** ("data as of…", scan age, next run, daily spend meter)
  and the **needs-attention inbox** on Home.

### Best-of picks where the designs diverged

- From **Steadyhand**: the plain-English safety copy everywhere — the
  three-outcomes block on every approval card ("if you approve / if you
  reject / if you do nothing", expiry countdown), guardrail one-liners, the
  "did nothing on purpose" framing for quiet runs, and the vocabulary layer
  (Running / Autopilot / Stopped / Exit-only / Winding down).  Autopilot is auto-decide only.
- From **TradeDeck**: the always-visible scope bar in the header, risk styled
  at the object, status-tone chips for lifecycle states, and the
  operator-density tables (positions, scorecards, tax lots).
- From **Ledgerline**: the decision-lifecycle organization of Activity, the
  **review-and-commit model for policy edits** (sparse draft → unified diff
  sheet with per-field LOOSER/TIGHTER classification → typed CONFIRM only when
  loosening brokerage-account authority), and "every number wears its passport" (humanized
  timestamps with exact-on-hover, `—` for missing data, buckets never sharing
  an axis).

## Structure

```
app/console/
  console.css        # scoped design tokens (.console-root), light + dark sets
  layout.tsx         # route-group layout: imports console.css, renders the shell
  page.tsx           # Home
  approvals/ activity/ strategy/ guardrails/ results/ settings/
  lib/               # useConsoleData (polled snapshot context), api (typed
                     # mutations incl. the LIVE_CONFIRMATION_REQUIRED contract),
                     # derive (client mirror of deriveExecutionState + honest
                     # derivations), format, useConsoleTheme
  ui/                # own primitives (Card/Btn/Chip/Meter/…), toast, sheet
  components/        # shell, chrome, nav, approval-card, positions,
                     # needs-attention, policy-form, equity-chart
```

## Theming

Semantic tokens only (`--con-*`), complete **light and dark** palettes aiming
WCAG AA; soft fills/borders derived with `color-mix` so every tone adapts.
Resolution: explicit `data-theme` on `.console-root` (persisted under the
console-scoped localStorage key `console:theme`, toggled from the chrome) else
`prefers-color-scheme`. No raw hex in components.

## Data honesty rules

- Missing data renders `—`; nothing is fabricated or interpolated.
- All money uses tabular numerals (`con-num` / `con-mono`).
- Timestamps humanize with the exact time on hover (`<Ago/>`).
- Practice-money and real-money figures never share an axis or a sum.
- Day P&L only renders when a prior-day snapshot exists, labeled with its
  baseline.

## Engineering constraints honored

- New files only — zero changes to `src/lib/**`, `app/api/**`,
  `middleware.ts`, or any existing UI file.
- No imports from `app/ui/*`; lucide-react for icons.
- Client components throughout the interactive tree; the route-group layout is
  the only server component.
