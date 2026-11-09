# Login hero wordmark, equal-size provider buttons, expanded legal copy

Date: 2026-08-20 · Agent: CLAUDE · Branch: `claude/login-hero-copy`

## 1. Context & Objective

Owner review of the iOS sign-in screen (screenshot, 2026-08-20): the candlestick
"SOCRATIC TRADE" wordmark rendered far too small, the three provider buttons did not
look like one set (Sign in with Apple was visibly narrower and its label larger), the
disclaimer needed to name the site and carry a fuller AI / not-advice notice, and the
value bullets were missing the framework-configuration promise that is the product's
core differentiator.  The website login shares this layout and the bullet list is
explicitly kept in sync with iOS, so both clients change together.

## 2. Changes Made

**iOS (`ios/SocraticTrade/LoginView.swift`)**

- Value bullets: added **"Configure strategic framework and guardrails"** as the first
  bullet, ahead of "Review and approve proposals".
- Wordmark: `CandleWordmarkView(height: 24)` -> `CandleWordmarkView(fillsWidth: true)`,
  so the mark scales to the content column and reads as the page headline instead of a
  top-bar glyph.
- Provider buttons now share one geometry: `contentWidth` 352, `buttonHeight` 50,
  `buttonRadius` 10 applied to Google, GitHub, and Apple alike.  The content column was
  400pt wide, above `ASAuthorizationAppleIDButton`'s hard 375pt width cap — that cap is
  exactly why Apple's button rendered narrower than the other two.  Dropping the column
  to 352 lets Apple's button fill its frame, so all three are identical.
- Google / GitHub labels moved from `.appSubheadline` (15) to `.appBody.weight(.medium)`
  (17) and their marks from 18 to 20pt, closing most of the size gap against Apple's
  native label (Apple scales its own label with button height and exposes no font knob).
- Disclaimer: `...keys stay with your account` -> `...keys stay with your account at
  SocraticTrade.com.`, and the second paragraph replaced with the owner's text — sign-in
  agreement pointing at the links below, the AI-not-guaranteed / user-defined-framework
  sentence, and the educational/experimental/informational not-advice sentence.

**iOS (`ios/SocraticTrade/CandleWordmarkView.swift`)**

- New `fillsWidth` flag on `CandleWordmarkView`.  When set, the Canvas takes the
  proposed width and derives its height from the sampled wordmark aspect ratio
  (`.aspectRatio(ar, contentMode: .fit)`) rather than drawing at a fixed `height`.
  Default stays false, so console chrome is untouched.

**Web (`app/login/page.tsx`)**

- Same new first bullet in `LOGIN_VALUE_BULLETS` (the list iOS mirrors).
- `HeaderLogo height={20}` -> `height={30}`.  Width is `height * WORDMARK_AR` (13.081),
  so 30 renders ~392px inside the `max-w-md` (448px) column less `px-4` = 416px of room.
- Legal copy replaced with the same three sentences, using `SENTENCE_GAP` for the
  two-space sentence gap (HTML collapses literal double spaces), and the Terms / Privacy
  links moved to their own centered row below the paragraph so "linked below" is true.

Touched files:

- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/CandleWordmarkView.swift`
- `app/login/page.tsx`
- `docs/EFFORT-LOG.md`, `STATUS.md`, this note

## 3. Decisions & Trade-offs

- **Apple's button stays native.**  Exact label-size parity with Google/GitHub would
  require a custom `ASAuthorizationController` button, which puts Sign in with Apple
  branding compliance on us at App Review.  Matching the box (width, height, radius,
  spacing) and raising the other two labels gets the "one set of buttons" read without
  that risk.
- **352pt column, not a wider one.**  The existing comment in `LoginView` warned against
  re-expanding the Apple button host past 375pt because it trips unsatisfiable
  autoresizing constraints.  Narrowing the column respects that warning instead of
  fighting it; the comment was updated to say why 352 is now the number.
- **Web disclaimer changed too.**  The owner quoted the iOS string, but the same
  "Not investment advice.  You set authority." sentence lived on the website login.
  Leaving one client with the short notice and the other with the full one would be
  inconsistent legal copy, so both carry the new text.  The web page has no
  session/keys lock line, so it starts at "By signing in, ...".
- Owner's text had a three-space gap before the last sentence; normalized to the
  standing two-space rule.

## 4. Verification State

```
npx tsc --noEmit                      # clean
npm run lint                          # 0 errors, 769 pre-existing warnings
npm test                              # 652 files / 7306 passed, 1 file + 51 tests skipped
npm run build                         # exit 0
xcodebuild build -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
                                      # ** BUILD SUCCEEDED **
```

Simulator screenshot (iPhone 17, iOS 26.5) confirms: two-line wordmark now fills the
column, four bullets with the new first row, three identically sized buttons, and the
full disclaimer above a Terms / Privacy row.

## 5. Next Steps & Blockers

None.  Copy-and-layout only; no auth, session, or order path touched.
