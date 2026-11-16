# 2026-08-12 — Web ↔ iOS parity review (expert panel)

## Context & Objective

Owner ask: "better parity with website on the ios app, ask team of experts to review how to
improve parity."  Ran a 7-agent panel (workflow `wf_79db5ae2-797`): two catalogers inventoried
every web surface (console destinations, mobile PWA, mobile-tabs model, admin dashboard) and
every iOS screen (including which decoded snapshot fields the app never renders and which
`/api/mobile` capabilities it ignores); four expert lenses reviewed both catalogs —
information-architecture parity, money-path completeness, native-platform fit, and
operator/admin mobile access; one synthesizer merged them into the owner-facing document below.

## Zero-Code Findings

This is a review, not a code change (the one exception: the panel's native-fit critique of the
in-flight customizable-tab-bar branch — "use the iOS 26 `Tab` builder, not legacy `.tabItem`" —
was applied immediately to that branch, `monet/ios-customizable-tabs`).

The full synthesis follows, verbatim, as the owner-facing report.  The same document is
published to Apple Notes as `[ST, Monet] Web vs iOS parity review`.

---

# Web vs iOS Parity Review — Socratic Trade

## Where iOS stands today

The native core is real and correctly chosen: Home, Proposals, Assets, and Activity cover the
remote-control loop, auth is done right, and pull-to-refresh plus SSE keep the foreground
fresh.  But the app is almost entirely read-only — orders can't be cancelled, policy can't be
tightened, and the two intermediate stop postures (Close Only, Wind Down) have labels but no
buttons.  Worst, there is no push notification support at all, so the phone is silent exactly
when a live proposal is waiting or a fill lands.  Several decision-critical fields (price
drift, red-team failure detail, account capabilities) are already decoded in Swift and simply
never rendered — cheap wins sitting on the table.

## Top 10 parity improvements

| # | Item | Why it matters on the phone | Effort | Depends on |
|---|------|-----------------------------|--------|-----------|
| 1 | **APNs push**: new pending proposal, fill, triggered price alert, run failure | Converts the app from "check compulsively" to "decide when summoned."  The entire Ask-First loop currently depends on spontaneously opening the app.  All three lenses ranked this first; backend event-notification plumbing already exists | L | New native surface (APNs entitlement, token registry) |
| 2 | **Render the decoded-but-unrendered proposal fields**: price drift since reference, `lastRevalidatedAt`, red-team `failureKind`, wash-sale note | Drift is the single most decision-relevant fact when approving hours after proposal (money-path lens).  Zero backend work — pure Swift render of fields already in the snapshot | S | Existing snapshot data |
| 3 | **Order cancel + replace-at-market**, with stale-limit flag in the snapshot | The only see-but-can't-act money surface.  A limit order rotting while you're away is exactly the phone emergency; today you can watch it but not kill it | M | New API (`order.cancel`, `order.replace_market` commands + stale-limit snapshot fields) |
| 4 | **Close Only + Wind Down buttons** on Home | The natural away-from-desk de-risk move ("stop opening, keep managing exits") doesn't exist — only binary Stop.  Both commands exist server-side, are protective, and even have labels already | S | Existing commands, pure UI |
| 5 | **Decode `runDuringExtendedHours`** | iOS can show "Running" while the console says "Paused · market closed" — a state lie in the single most-glanced pill, on the device you trust remotely.  Fix regardless of roadmap | S | Existing snapshot data (one field) |
| 6 | **Protective policy tightening**: Autopilot → Ask-First downgrade, cut notional caps | "I'm uneasy, take the keys back" is a core phone use case and it's impossible today.  `policy.patch` already exists and validates everything; ship the tighten direction only, keep loosening on web (money-path lens's asymmetric-friction argument) | M | Existing `policy.patch` command |
| 7 | **Universal links + deep-link routing** | No `onOpenURL` handler exists — any link into the app is silently dropped.  This is what makes push payloads, widgets, and emailed alerts land inside the app instead of nowhere.  ~20 extra lines adds Handoff to the desktop console | S | New native surface (associated-domains + AASA) |
| 8 | **Decode `snapshot.catalog`** | The app hardcodes its command list, so every new command above needs an App Store release instead of a server-advertised capability.  Version skew by construction — already the root cause of item 5 | M | Existing snapshot data (catalog v2 already served) |
| 9 | **Widget + Live Activity** | Equity + day P&L + pending count on the home screen; a pending live proposal with an expiry is a textbook Dynamic Island countdown.  Read-and-deep-link only — never an Approve button in a widget.  Requires moving the snapshot cache to an App Group first, and Live Activity pushes ride on item 1 | L | New native surface (WidgetKit/ActivityKit; depends on items 1 and 7) |
| 10 | **Watchlist quotes + mini symbol drilldown** | The watchlist is naked symbols today, which defeats the glance.  Tapping any ticker goes nowhere; even a mini sheet (price chart, position, pending order) closes the "approving blind to the tape" gap | M | Existing APIs (`/api/quote`, `/api/history`) + snapshot merge for watchlist prices |

Honorable mentions, all cheap: swipe-to-reject on proposals, swipe-to-delete on watchlist and
alerts, render `ConnectedAccount.capabilities` and `isDraining` in the account sheet, show
`triggeredAt`/`triggeredPrice` on fired alerts, App Intents for "Stop trading" (a perfect
Action Button candidate).

## Do NOT port these

Per the native-fit lens, these web surfaces should stay web or become a different native thing:

- **The command palette** — its native counterpart is App Intents/Siri, not a ⌘K UI.  Never
  expose approve-live as an intent; reject is fine.
- **Home dashboard cards as more in-app cards** — that content belongs in widgets and
  notifications, not additional scroll.
- **The Insights tab** — rule-based sentences with zero actions.  Fold its cards into Home;
  the "warn at 80% utilization" logic is literally a lock-screen gauge widget.
- **Guardrails/Strategy editing depth** — the PolicySaveBar review-and-commit flow and
  typed-CONFIRM rituals are a huge safety-subtle surface.  Reach it via authenticated web
  handoff; go native only for the 2-3 high-frequency numeric caps (item 6 above).
- **Symbol drilldown depth, Results, Macro, Scan, Coach chat, Settings** — web handoff beats
  native rebuilds for the long tail.  Note the cookie-jar caveat: WKWebView doesn't share the
  URLSession session, so budget for cookie injection before promising embedded views.
- **A WebView of `/mobile`** — the PWA duplicates the native tabs.  Native owns the control
  loop; web owns depth.  Two remote controls in one app is worse than either.
- **Custom-scheme content routing** — `socratictrade://` stays auth-callback-only; content
  links go through universal links.
- **"SSE is the only signal"** — keep SSE for foreground refresh, but push replaces it in
  background, not in app.

## Mobile admin access

**Recommendation: approve an authenticated WKWebView onto `/admin`, gated on
`currentUser.isAdmin` (already decoded, never used).**  The admin pages ship their own
responsive mobile frame, all 8 are read-only diagnostics, and the mobile session cookie is a
real Auth.js session that passes `requireAdmin` with zero server changes.  Entry point is an
"Admin Portal" row in the existing Account & Settings sheet, deep-linking to Overview,
Connections, Server, and LLM Usage; keep the dense-table pages (data catalog, RAG coverage,
transcript) off the phone menu.  Build notes: copy the session cookie into `WKHTTPCookieStore`
before first load, bounce to native re-auth on expiry instead of letting OAuth happen inside
the sheet, lock navigation to `socratictrade.com/admin*`, and confirm the zone's WAF UA rules
don't block WKWebView.  Do not rebuild admin panels natively — the JSON shapes change weekly
and the owner is the sole user; if a native glance is ever wanted, it's one
`GET /api/mobile/admin-brief` endpoint rendered as one card, nothing more.

## Already in flight

The customizable glass tab bar (web-parity pin/unpin model with min-2/max-4 + More) is being
implemented this session per owner direction — noting for the record that the native-fit lens
argued 5 tabs need no customization layer on iOS, so if it's kept, it should ride the iOS 26
`Tab` builder and bottom-accessory conventions rather than the legacy `.tabItem` API.

---

## Next Steps & Blockers

- Owner picks from the Top 10 (items 2, 4, 5 are S-effort with zero backend work — natural
  first wave; item 1/APNs is the highest-leverage L).
- Mobile admin access: awaiting owner approval of the WKWebView-onto-`/admin` recommendation.
- The `Tab`-builder critique is already applied to `monet/ios-customizable-tabs`.
