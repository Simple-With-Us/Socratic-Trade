# 2026-08-02 — /console/connections route-local skeleton (Codex finding 22, residual half)

**Agent:** MONET · branch `monet/connections-route-skeleton` (off `origin/main` @ `c117afb9`)

## 1. Context & Objective

Codex external-review finding 22 flagged that routes which don't need the full dashboard
snapshot still sat behind the shell's full-screen loader (legitimately up to ~24s on a slow
broker chain — the sequential broker-chain bound documented in `useConsoleData.tsx`). The
`/console/usage` half was fixed 2026-08-01 in PR #2341 via the `SNAPSHOT_INDEPENDENT_ROUTES`
allowlist in `app/console/components/shell.tsx`. This change fixes the residual half:
`/console/connections` returned `null` until the snapshot arrived, even though half the page
(ApiKeysCard) fetches its own data from `/api/keys` and never reads the snapshot.

## 2. Changes Made

Connections can NOT join `SNAPSHOT_INDEPENDENT_ROUTES` (BrokerAccountsCard reads
`connectedAccounts`, `policy`, and per-account pending counts), so instead:

- **`app/console/components/shell.tsx`**
  - New `SELF_SKELETON_ROUTES` set (`/console/connections`): routes that DO read the
    snapshot but handle `snapshot === null` themselves. OR'd into the existing early-render
    branch, so the route paints immediately without the snapshot-derived chrome.
  - The early-render branch now wraps children in `ToastProvider` (inside `.console-root`
    for token scoping). **This fixed a real bug found during live verification:** ApiKeysCard
    calls `useToast()` unconditionally, and without the provider the route 500'd on SSR
    ("useToast must be used inside ToastProvider"). `/console/usage` never tripped this
    because LlmUsageClient doesn't use toast.
  - Comment updates: the old "connections looks like a candidate and is NOT one" note now
    points at the new set; the new set's doc warns that pages added there must render
    something meaningful for BOTH `snapshot === null` states (loading AND watchdog error),
    because the branch also bypasses the shell's error card.
- **`app/console/connections/page.tsx`**
  - No more `return null`: the h1, ALL-YOUR-ACCOUNTS chip row, and both anchor section
    frames (`#brokers`, `#api-keys`) render unconditionally.
  - `#brokers` renders `BrokerAccountsCard` when the snapshot is ready, otherwise a new
    route-local `BrokerConnectionsPlaceholder` styled as a `con-card` with the real card's
    header frame ("Broker connections") and `animate-pulse` bars (`rounded-control`,
    `--con-line` / `--con-surface-2` tokens), `aria-busy` + sr-only polite live region.
  - Because the shell's error card is bypassed for this route, the placeholder is the
    route's only failure surface: when the first-load watchdog gives up
    (`!loading && error`) it renders the error + "Retry now" (`refresh()`) instead of
    pulsing forever — mirroring the shell error card's semantics, scoped to the section.
  - `#api-keys` renders `ApiKeysCard` unconditionally (verified snapshot-free: no
    `useConsoleData` reference; it fetches `/api/keys` itself and has its own
    loading/error states).
  - Deep-link hash scroll: the effect now runs on mount (anchors exist from first paint,
    so `/console/connections#api-keys` orients immediately) AND re-runs when `ready` flips
    true (the placeholder is replaced by real content of a different height, which shifts
    the anchor — the second scroll corrects it).

## 3. Decisions & Trade-offs

- **A sibling set, not a widened allowlist.** `SNAPSHOT_INDEPENDENT_ROUTES` keeps its
  strict "consumes ZERO snapshot fields" semantics; `SELF_SKELETON_ROUTES` is a distinct
  contract ("page handles null snapshot itself"). Mechanically they share one code path.
- **One unified shell tree, not two returns (adversarial-review-driven redesign).** The
  first cut early-returned a bare `<ToastProvider><main>` tree and kept the loaded tree
  separate. A 3-lens / 10-agent adversarial review workflow confirmed (7/7 findings, 0
  refuted) that with keyless index reconciliation the snapshot's arrival was a
  destroy-and-recreate of the page subtree: mid-edit ApiKeysCard state (a half-typed key)
  wiped, in-flight toast feedback silently swallowed by the unmounted old provider,
  duplicate `/api/keys` fetch, and ConsoleIntro mounting LATE as a click-intercepting
  full-viewport splash over an already-interactive page. Final shape: ShellFrame has ONE
  success-path return; the snapshot-derived chrome (topbar, DesktopRail, FreshnessStrip,
  MobileTabBar, ConsentGate, CommandPalette) renders in fixed null slots, so child indices
  are stable and the snapshot's arrival mounts chrome AROUND the live page without
  remounting it. ConsoleIntro + SymbolDrawerProvider now mount in the bare window too
  (intro plays over the skeleton exactly as it does over the loader; the drawer provider
  takes no snapshot input). A shell comment forbids re-splitting the branches.
- **Review-driven a11y/design fixes** (all confirmed by verification agents):
  - `console.css` reduced-motion rule now clamps `animation-iteration-count: 1` — with
    duration-only clamping, infinite animations (`animate-pulse`, `.con-dot-pulse`)
    flicker per-frame for exactly the reduce-motion audience. Pre-existing gap, but this
    change added the console's largest infinite-animated surfaces.
  - Skeleton header renders inert stand-ins for the real card's three connect buttons
    (real `con-btn con-btn-outline con-btn-sm` classes, invisible labels) so the swap
    doesn't change header height / wrap and shift ApiKeysCard mid-interaction.
  - sr-only loading region mounts EMPTY and is populated in an effect (live regions
    announce changes; pre-populated mounts are typically not read), and `aria-busy` was
    dropped from the card (it licenses AT to suppress the very announcement inside it).
  - `role="alert"` moved from the error card section to the message paragraph only; the
    Retry button stays a plain discoverable sibling.
- No new dependencies. No test files exist for these components (UI pages have no RTL/jsdom
  harness in this repo); coverage is the full vitest suite + live browser verification +
  the adversarial review workflow.

## 4. Verification State

- `npx tsc --noEmit` — clean (Node 24 PATH prefix).
- `npx eslint` on both touched files — 0 errors (2 pre-existing grandfathered warnings in
  shell.tsx untouched by this change).
- Live dev-server verification (Monet worktree, port 3005):
  - SSR HTML of `/console/connections` contains the skeleton card ("Broker connections",
    `animate-pulse`, "Loading broker connections…"), both anchors, live ApiKeysCard in its
    own "Loading key status…" state, and the h1 — proving the pre-snapshot render (SSR
    always renders with `snapshot === null`).
  - Browser pass: `#api-keys` deep link scrolled correctly; post-snapshot state renders the
    real Broker Connections + API Keys cards with full chrome; zero console errors.
  - The pre-fix 500 (useToast) was caught by this live pass — it would have shipped on a
    code-review-only verification.
- Post-fix re-verification: tsc clean again; eslint 0 errors (2 pre-existing shell.tsx
  warnings only); SSR HTML re-checked (button stand-ins present, `aria-busy` gone, status
  region empty at mount, anchors intact); browser reload with the unified tree — zero
  console errors (no hydration mismatch), `#brokers` deep link scrolls under the sticky
  chrome, real card mounts, exactly ONE `.con-toasts` viewport.
- `npm test` + `npm run build` run via `scripts/land.sh` at landing time (full trio gate).
- Adversarial review workflow: 3 review lenses (React/Next semantics, state-machine
  coverage, design-system/a11y) + per-finding refutation agents, 10 agents total —
  7 findings confirmed, 0 refuted, ALL 7 fixed before landing (see §3).

## 5. Next Steps & Blockers — PARKED 2026-08-02, then RESOLVED same day

**Resolution addendum:** the park was picked up (AG marked PR #2350 ready; squash
auto-merge armed) and CI's `verify` ran the full test+build GREEN on the final tree,
closing the one gap listed below. The branch was then re-merged with `main`
(#2349/#2351 had advanced it; the ruleset's strict up-to-date rule stalls auto-merge
otherwise) with the union-spliced STATUS.md de-spliced again, and lands unattended on
the re-run's green. Historical park-state record follows.

Work was stopped by the owner mid-landing. Exact state at park time:

- **Done:** implementation, all 7 adversarial-review fixes, tsc clean, eslint 0 errors,
  live dev-server verification (SSR skeleton + deep links + zero console errors),
  `origin/main` merged in (`f7187a1e`) with the STATUS.md union-splice deliberately
  de-spliced (`d78e13c0`). Branch pushed; draft PR open (number in the live board /
  #ag***-s**c closeout).
- **Interrupted:** the second `scripts/land.sh` run was killed during its gate phase, so
  the FULL `npm test` + `npm run build` have NOT been run against the final tree
  (first land.sh run aborted pre-gates on the board-file overlap check, by design).
- **Pickup (any agent):** from `~/apps/trading-monet`:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH" && LAND_ALLOW_STALE_OVERLAP=1 bash scripts/land.sh`
  (idempotent; the overlap bypass is justified — the STATUS/EFFORT-LOG overlap was
  manually reviewed and de-spliced). Then mark the draft PR ready and
  `gh pr merge <n> --squash --auto`. Merge auto-deploys to production.
- Optional follow-ups (non-blocking): same treatment for other chrome-light routes if
  any emerge; a shared `<CardSkeleton>` primitive if a second route-local skeleton
  appears (deliberately not abstracted at n=1).

## 6. Zero-Code Findings

- The preview harness reads `.claude/launch.json` from the session's primary cwd (the main
  integration worktree), NOT the worktree the agent edits in — a lane server must be
  declared there (gitignored local file) with an explicit `cd`/`--prefix` into the lane and
  a Node 24 PATH prefix (default Homebrew node 26 crashes `better-sqlite3` lane builds).
