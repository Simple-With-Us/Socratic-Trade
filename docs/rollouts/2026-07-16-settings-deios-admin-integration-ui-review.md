# 2026-07-16 — Settings de-iOS restoration, admin integration, Configure IA, site-wide UI review (MONET)

## Summary

Owner escalation: "nobody is able to make the Settings page look half decent… it looked
10 times better 3 days ago… it looked like all the other parts of the site." Root cause
identified by git archaeology, fixed by restoration rather than another reskin, plus the
owner's three structural asks (admin link at top of site, admin portal that feels like
the same app, more intuitive Configure tabs), driven by a 7-expert multi-agent UI review
of every console surface.

## Root cause (why every previous "fix" showed ~zero improvement)

- 2026-07-12 `d236f9d6` (PR #1476, "iOS UI refresh") converted the Settings page AND all
  seven sub-card modules from the console design system (`Card`/`Field`/`Toggle`/`Chip`
  from `app/console/ui/primitives.tsx`) to new iPhone-Settings-style components
  (`app/ui/ios-components.tsx`: List/ListSection/ListRow/LabeledContent — full-width rows,
  control pinned far right, chevrons). Settings stopped matching every other page.
- The two subsequent "fixes" — `bb2a…` #1535 (theme tokens) and `001d8af0` #1651
  (con-card outer containers + SettingsGroup) — only reskinned the CONTAINERS. Row
  internals stayed iOS, so the page still didn't read like the rest of the site.
- Concrete regression evidence (screenshots in the PR): current desktop-light Settings
  is 7,003px tall vs 5,325px on July 11 (+31%) with only ~6 genuinely new controls;
  event notifications became ~18 full-width single-column iOS toggle rows labeled with
  RAW snake_case event ids (`run_failed`, `kill_switch`, `autonomy_halted_on_boot` …),
  7 of 18 with no explanatory hint at all, vs July 11's compact two-column plain-English
  checkbox grid.

## What changed

(filled in as workstreams land)

1. **Settings de-iOS restoration** — every settings module restored to its `ffdc9d1f`
   (July 11) console-primitive architecture with ALL post-July-11 content ported forward:
   - `api-keys.tsx`, `delivery.tsx`, `sharing.tsx`, `help.tsx`: zero content drift since
     July 11 (verified per-commit) — verbatim restorations.
   - `brokers.tsx`: restoration + #1492 (Exit Replacement blockers) and #1544 content;
     the #1544 Test-Account-button removal is deliberate product direction and was
     preserved (not resurrected).
   - `danger.tsx`: restoration + #1492 `activeReplacements` deletion-blocker.
   - `learning-review.tsx`: restoration + #1544 model options + #1631 threshold/max-wait
     knobs and the save()-reports-success fix.
   - `page.tsx`: July-11 shell (Chip-labeled scope sections, two-column event grid) +
     complete plain-English `EVENT_LABEL`/`EVENT_HINT` maps for all notification event
     types (typed `Record<NotificationEventType, …>` so a future event type without copy
     is a compile error, not a snake_case leak).
   - `app/ui/ios-components.tsx` DELETED (grep-verified zero remaining imports).
2. **Admin at top of site** — admin-only `Admin` link (ShieldCheck) in the desktop
   ChromeBar + `Admin portal` entry in the UserMenu (phone path), gated on
   `snapshot.currentUser?.isAdmin`.
3. **Consent-gate decline now sticks** — `GET /api/consent` computed `needsConsent` as
   "not accepted", so a recorded DECLINE re-prompted the blocking dialog on every console
   load, contradicting the gate's documented semantics. Any recorded answer at the current
   consent version now resolves the gate; actual pooling stays gated on explicit accept
   (`hasDataPoolConsent` unchanged).
4. **Admin portal restyle** — `/admin` moved off the legacy glass-token system onto the
   console design system: layout imports `console.css`, root is `.console-root` driven by
   the SHARED `useConsoleTheme`/font hooks (one theme choice across both surfaces), sticky
   top bar with an always-visible "← Console" as the first control at every breakpoint,
   Operator rail using the console `con-nav-item` idiom, and all six page clients
   (overview, connections, llm-usage, rag-coverage, server, transcript) migrated to
   `Card`/`Chip`/`Btn`/`Meter`/`Segmented`/`con-table`. Deleted: fake ticking-clock pill,
   hardcoded "LIVE" pulse, bottom-of-sidebar back link. Because `/console/usage` mounts
   the same `LlmUsageClient`, this also fixed the P0 "admin design system rendered
   wholesale inside the console" on the Usage page. `app/ui/markdown.tsx` (legacy twin,
   zero consumers after the port) deleted.
5. **Configure IA** — nav labels now match what the pages call themselves: "Framework" →
   **Strategy**, "Mandates" → **Guardrails** (routes unchanged); NEW **Connections** page
   (`/console/connections`) takes Broker connections + API keys out of Settings (the
   one-time-setup half of the old monolith); `#brokers`/`#api-keys` deep links retargeted
   (+3-line hash safety net for old bookmarks; Robinhood OAuth callback redirect updated);
   Webhook URL moved into Delivery channels next to its channel toggle; Tax treatment
   moved from Strategy to Guardrails (next to the Tax rules it feeds); Guardrails
   Essentials got Schedule / Short selling sub-headings; Strategy reordered Models-first;
   copy sweep so no user-facing string says "Framework"/"Mandates" for a nav destination.
6. **Site-wide quick wins** — naming canon "h1 = rail label" via a new exported
   `destinationLabel()` helper (Proposals, Journal, Evidence, Regime, Outcomes, Coach —
   9 of 13 surfaces had diverged); Journal audit rows titled "… failed" no longer get a
   green "Completed" chip (status derived from title when the event carries none);
   deleted two fabricated-tag blocks that forced a "paper" tag ("Live is not tested yet")
   and a blanket "notification failed" tag onto every feed group; scan's Congress verdict
   chip renders decided vocabulary (Pass / Fails significance / Not enough data) instead
   of raw enums; `connection_health_alert` audit rows say which provider is failing in
   plain English instead of a "Key Source: none" scalar dump; approvals leads with the
   empty-state card when the queue is empty (triage apparatus only renders with a queue)
   and its h1 count hides at zero; icon-only Run once in the phone chrome (the hero's
   call-to-action was unreachable on mobile); Coach lost its duplicate in-card "Assistant"
   h1 and its composer no longer sits under the mobile tab bar; Strategy custom-model
   warning box moved from Tailwind amber+dark: (dead under data-theme) to con-warn
   tokens; `text-muted-foreground` (undefined class) → `--con-faint`; `TONE_VAR.live`
   aligned to the accent-tinted `.con-chip-live`; PWA themeColor synced to `--con-bg`;
   "NO ACCOUNT · no account connected" tautology reworded; watchlist copy names the
   "Price alert" notification instead of the `price_alert` event id; brokers-card connect
   buttons wrap on phones (Settings no longer scrolls horizontally at 390px).

## Why

Owner-directed (2026-07-16 session). Design decisions came from a 7-expert parallel
review workflow (settings restoration, configure IA, admin integration, core surfaces,
review surfaces, mobile+dark, design language) + design-lead synthesis; specs are
session artifacts, key conclusions recorded here and in the PR description.

## Files

(exact list at land time — `git diff --stat main...`)

## Verification

(exact commands + results at land time; includes full-page screenshot re-shoot of all
16 pages × desktop-light/desktop-dark/mobile-light and acceptance-criteria review)

## Follow-ups (deliberately deferred — WS-E backlog from the panel synthesis)

- Radius canon sweep: ~121 `rounded-md/lg/xl` call sites → `rounded-card`/`rounded-control`
  (utilities already generated from `@theme`); own mechanical PR after this wave.
- `--con-fs-2xs` micro-type token + sweep of ~15 ad-hoc 9–12px font sizes.
- Move Market-scan shape + Daily learning review cards to Strategy with an
  ALL-YOUR-ACCOUNTS chip — defensible either way; owner call (retargets the
  `settings#learning-review` deep link).
- Coach first-run model preselect (behavior semantics — owner sign-off needed).
- Intro splash polish (pointer-events after dissolve, brand-reveal timeout, theme-var
  candle colors).
- Regime board: collapse fully-dead tile sections to one Empty line + reorder live-first.
- Public/marketing pages (error.tsx, framework viewer, privacy policy) still use the
  legacy `app/ui/primitives.tsx` glass system — last non-console holdout, separate pass.
- Watchlist "never trades" reassurance appears in 4 spots — trim to one (kept the alerts
  paragraph fix only this wave).
- Consent-gate theme: an explicitly stored `console:theme` isn't applied on first paint
  (pre-existing, console-wide; admin now matches console behavior).
