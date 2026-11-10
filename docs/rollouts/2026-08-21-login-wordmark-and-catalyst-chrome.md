# Login wordmark, justified legal copy, and two Catalyst-only defects

2026-08-21 · CLAUDE · branch `claude/login-wordmark-catalyst`

## Why this is small

The owner's ask covered the login screen AND a width-aware tab bar AND an iPad Air layout
pass.  While that was in flight, **PR #2987 landed the tab bar and the layout pass** from the
same verbatim prompt.  Everything this branch would have duplicated has been dropped rather
than merged over the top — see "What was dropped".  What remains is the part #2987 never
touched: the login screen, and two defects that only show up on Mac.

## 1. The wordmark was frozen

`TimelineView(.periodic(from: .now, by: 1.0))` anchors its phase to the `.now` captured when
the schedule is built, and SwiftUI rebuilds that schedule every time the body is
re-evaluated.  Inside a `ScrollView` that is constant, so the next entry kept being pushed a
second into the future and the mark sat on one frame indefinitely.  The web `HeaderLogo`
drives the same integer tick off `requestAnimationFrame` and has no such anchor — which is
exactly why the site moved and the app did not.

Now on the display-link-backed `.animation(minimumInterval:paused:)` schedule with a `@State`
start date.

**The same defect is in `SnapshotScaffold`** (`.periodic(from: .now, by: 30)`), which is what
drives the "updated N seconds ago" line on every tab.  Fixed with a `@State` anchor.  It
survived #2987 because that PR rewrote the scaffold's layout, not its schedule.

## 2. Login copy and shape

- Wordmark at 80% of the content column (owner: 20% smaller).
- "strategic" dropped from the first value bullet, in the app and in the web
  `LOGIN_VALUE_BULLETS` it is kept in sync with.
- The lock line and the disclaimer are ONE justified paragraph now, sitting to the right of
  the lock, which hangs into the column gutter so the text keeps full width.  Every line lands
  on the same right edge; the last line is left alone.  "Socratic Trade" removed before
  "session".
- New shared `JustifiedText`: SwiftUI has no justified case — `TextAlignment` is
  leading/center/trailing and `Text` ignores an `NSParagraphStyle` on an `AttributedString`.
- The column vertically centres on anything taller than it needs.

## 3. Two defects the Mac app made visible

Found by building the Catalyst app and capturing its own window, which is the only visual
verification available while this Mac's iOS simulator is wedged.

- **The login screen was wearing the signed-in chrome.**  `ContentView` held both screens
  permanently and switched with `.opacity`.  That is invisible on iOS, but a TabView's bar and
  a NavigationStack's title are promoted into the WINDOW's chrome on Catalyst, which an
  opacity modifier inside the scene never reaches — so the Mac login screen had a live
  "Home · Proposals · Assets · Activity · More" bar across it and "Home" in the title bar, for
  an app you were not signed in to.  It also left the login wordmark's TimelineView ticking
  behind the whole app all session.  Both screens are built conditionally now.  The deep-link
  guarantee still holds: `pendingDeepLink` lives in `ContentView`, so a link arriving before
  sign-in survives and the shell applies it from `onAppear`.
- **The justified paragraph had rivers, and they were mine.**  Written first as a `"""`
  literal with `\` continuations, whose stripped indentation survived into the string as
  nine-space runs that justification then stretched mid-sentence.  Explicit concatenation now.

## 4. Two small fixes carried over

- **`SwipeRevealAction` was lying to VoiceOver.**  It attached its rotor action
  unconditionally with a `guard isEnabled` INSIDE, plus an unconditional hint promising a
  swipe.  A row whose action is disabled therefore advertised a "Cancel Order" that silently
  did nothing.  `accessibilityAction(named:)` has no conditional form; `accessibilityActions`
  does.
- **`SymbolInfoSheet` gets `.presentationSizing(.page)`** — a default sheet is a ~540pt
  keyhole on iPad for a nine-card screen.  Documented as inert in compact width.

## What was dropped, and why

Superseded by #2987, which landed first and in several respects went further (auto-fill to
capacity on a fresh install, an aggregate More badge, a three-column `CardColumns` masonry):

- the whole `TabPreferences` / `MobileControlView` rewrite and its tests
- `AppLayout` + the content column, `appScreenTitle`, `AppMetricGrid`, `AppCardGrid`,
  `AppSplitColumns`, and every per-screen adoption of them (Home, Proposals, Markets,
  Activity, Results, Insights)

Not re-applied here even though #2987 did not touch it: the Markets confirmation-dialog
re-anchoring.  It was worth doing when cards sat in a wide grid; on main the scaffold's
columns are ~373pt, so a row-anchored popover is already reasonably precise, and it is not
worth widening this PR for.  Filed as a follow-up instead.

## Gate

216 tests.  The single failure is `AgentControlPlanTests.testLiquidatingHidesWindDownAndKeepsCloseOnly`,
which **fails on clean `origin/main`** and is unrelated to this branch — it is corrected in
PR #3007.

Run on the **Mac Catalyst** destination: `simdiskimaged` on this Mac is wedged and
root-owned, so `simctl` blocks and simulator boot times out.  Fix is
`sudo launchctl kickstart -k system/com.apple.CoreSimulator.simdiskimaged` or a reboot.

Verified visually on the Mac.  **iPhone and iPad screenshots are still owed.**

## 5. The provider buttons — uniform row, brand in the logo

Owner: *"The sides of the non Apple sign in boxes look strange in ways that aren't necessary
for branding or policies… find a way to make them look more similar but be branded still."*

**The "strange sides" had a mundane cause.**  The Google and GitHub buttons had no
`.buttonStyle(.plain)`, so SwiftUI's default bordered style was painting its own rounded
rectangle *behind* the custom background — a grey ghost box, slightly larger than the button,
visible along the edges.  Apple's row never had it because `SignInWithAppleButton` is a
UIKit-hosted view, not a SwiftUI `Button`.  That is why exactly two of the three looked wrong.
The same bug was giving Terms and Privacy grey pill chrome under the legal paragraph.

Beyond the bug, the row was three unrelated designs: accent-filled Google, outlined GitHub,
system-black Apple.  It is now one component rendering three rows — same height, radius,
fill, border, type ramp and logo column — with the brand carried entirely by the mark.  This
is the pattern the owner named (Infisical) and the one a survey of Linear, Supabase, Vercel,
Notion, Raycast, Figma, Cal.com, Clerk and Sentry converges on.

Researched against primary sources rather than assumed, and the rules turned out to *favour*
uniformity rather than obstruct it:

- **Google.**  The old teal button broke an explicit Don't: *"Put the standard color Google
  'G' icon on a colored background other than light, dark, or neutral."*  The new row is
  Google's **Light** theme verbatim — fill `#FFFFFF`, 1px inside stroke `#747775`, title
  `#1F1F1F` — and their Dark theme (`#131314` / `#8E918F` / `#E3E3E3`) in dark mode, with
  their documented iOS padding (16pt before the logo, 12pt after).  Google also asks their
  button be *"at least as prominently"* displayed as other providers and of *"approximately
  the same size and similar visual weight"*, which a uniform row satisfies by construction.
- **Apple.**  A custom button is explicitly permitted, and the HIG names this exact
  motivation: *"you may want to align logos across multiple sign-in buttons."*  The native
  control could never have been aligned — its fill, font and metrics are the system's, and
  `ASAuthorizationAppleIDButton` is documented as "don't otherwise modify the style".  Every
  pinned attribute is honoured: one of the three permitted titles, a black-or-white
  background, logo and title both the same pure black or white, and the title at 43% of
  button height — which is why the button is **44pt with a 19pt title**, the HIG's own worked
  example.  The HIG separately allows the bezel stroke, a non-system title font, and insetting
  the logo to align it with other providers.
- **GitHub.**  No button rules at all; the only constraints are on the mark.  The old
  chevron-slash SF Symbol was not a GitHub mark — it read as a generic "code" glyph.  Replaced
  with the official **Invertocat** from `brand.github.com/GitHub_Logos.zip`, shipped as a
  vector PDF and template-rendered so it resolves to black or white, the only two colours
  GitHub permits.  Its artwork is 98x96, not square, so it is aspect-fitted rather than
  stretched.

Switching Apple to a custom button meant driving `ASAuthorizationController` directly.  The
credential handling is untouched — `configure` and `complete` are the same functions; only
what starts them changed.  `AppleSignInCoordinator` exists because the controller holds its
delegate **weakly**, so a coordinator scoped to the tap would be deallocated before the sheet
appeared; SwiftUI used to own that lifetime for us.

**A bug this surfaced.**  Running the Catalyst build, the Apple flow failed and put
*"The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError
error 1000.)"* on screen.  That was pre-existing — `complete` assigned
`error.localizedDescription` straight to `store.error` — and it is exactly the register
`UserFacingCopyTests` exists to keep out of the UI.  Now mapped to plain language per case,
with cancel returning nothing at all so backing out does not raise an error banner.

### Known deviations, stated rather than buried

- **Google's spec names "Google Sans Medium" for a custom button.**  This app ships Lato and
  cannot license or bundle Google Sans; every other value in Google's colour and padding table
  is followed exactly.
- **Apple's HIG says to use the logo artwork downloaded from Apple Design Resources.**  This
  uses SF Symbols' `apple.logo`, which is Apple's own vector artwork rather than a
  hand-drawn one, but it is not the downloaded file.  Vendoring the official PDF is the
  strictly-literal upgrade and would be a small follow-up.
- **Not verified in dark mode or on a device.**  Only the Mac light appearance has been seen.
