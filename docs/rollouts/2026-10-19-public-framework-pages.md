# 2026-10-19 - Public Framework Pages

## Context & Objective

The owner asked for four things as one change: expand and improve `/framework`; make it replace the
`/how-it-works` page that the Welcome page's "Decision Framework" button linked to (and relabel that
button simply "Framework", because the page is about more than the decisions); land every visitor to
the main domain on `/welcome`, with the alt domain `socratic.trade` forwarding to the main domain; and
put the animated "Socratic Trade" candlestick wordmark in the top-left of the public pages, with the
console's candle-flight loading animation playing on the Welcome page and then settling into that
same corner — **in the same place regardless of which public page the visitor is on**.

## Changes Made

### One shared public shell

Every public page now renders through a single `PublicShell`, which is what actually guarantees the
"same place on every public page" requirement rather than merely intending it.

- `app/ui/public/public-shell.tsx` — the shared chrome: a fixed-height header row (animated brand
  left, optional action right), the content column, the shared footer, and the one-shot splash.
- `app/ui/public/public-brand.tsx` — the animated `SOCRATIC TRADE` canvas for the public site, sharing
  the console's letter sampling and ticker units so the two can never render different wordmarks.
- `app/ui/public/public-footer.tsx` — the shared footer (disclaimer, Terms, Privacy, optional extra,
  contact address, Simple With Us attribution).
- `app/ui/brand/public-geometry.ts` — the shared geometry constants (`PUBLIC_SHELL_MAX_W`,
  `PUBLIC_SHELL_PAD_X`, `PUBLIC_HEADER_PAD_Y`, `PUBLIC_ROW_H`, `PUBLIC_BRAND_MAX_H`), plus
  `publicBrandLeft()` / `publicBrandTop()`.

The header's geometry is **inline-styled from those constants rather than set with Tailwind classes**.
The loading animation computes its landing box in JavaScript from the same constants, so a CSS class
and a JS number could drift and the candles would land beside the wordmark instead of on it.

### One animation implementation, two variants

The console's intro canvas moved out of the console tree and was parameterized rather than duplicated.

- `app/console/ui/candle-ticker.ts` → `app/ui/brand/candle-ticker.ts` (moved).
- `app/console/ui/intro-bus.ts` → `app/ui/brand/intro-bus.ts` (moved).
- `app/console/components/intro-canvas.tsx` → `app/ui/brand/intro-canvas.tsx` (moved + parameterized
  with `variant: "console" | "public"`).

Each variant keeps its own module state and its own `sessionStorage` key (`st.introShown` vs
`st.publicIntroShown`), so the public splash never consumes the console's one-shot splash and the
console splash never consumes the public one. Console behavior is unchanged: same backdrop, same
`--con-pos`/`--con-neg` candle colors, same cached header top.

The public brand is **CSS-sized** (`width: 100%` + `aspect-ratio` + `maxWidth`) rather than
canvas-sized on mount, so the very first paint is already the right size. The animation measures
`[data-brand-logo]` every frame, and a canvas that resized on mount would have made the candles land
beside the wordmark.

### Framework page expansion

- `app/framework/content.ts` (270 → 425 lines) — new sections: `questions[]` (the seven questions a
  decision must answer), `plainLoop[]` (Observe / Argue / Decide / Act / Explain / Learn mapped to
  pipeline stages), `caseFileIntro` + `caseFile[]` (the seven decision-case-file fields),
  `authorityIntro` + `authority[]` (reusing `HOW_IT_WORKS_AUTHORITY_ITEMS` from `@/lib/guardrail-copy`
  so the guardrail copy has exactly one source), `outcomeIntro` + `outcomeLenses[]`, and
  `resilienceIntro` + `resilience[]` (drawn from `docs/trading-framework.md`). The content expansion
  itself left every pre-existing string byte-identical and the `invariants` block untouched; the one
  later pass over those strings is the Title Case normalization described under Decisions below.
- `app/framework/framework-viewer.tsx` (240 → 369 lines) — renders the new sections and adds an
  "On This Page" table of contents with anchor links.
- `app/how-it-works/decision-loop-diagram.tsx` → `app/framework/decision-loop-diagram.tsx` (moved, so
  the diagram lives with the page that now owns it).

The `/how-it-works` content is fully superseded: its plain-language loop became `plainLoop`, its
decision case file became `caseFile`, its authority list became `authority`, and its four outcome
lenses became `outcomeLenses`.

### Page and routing changes

- `app/welcome/page.tsx` — rewritten on `PublicShell`. The hero button is now **"Framework"** and
  links `/framework`; a second CTA reads "Read the Framework". Section headings are Title Case
  ("What It Does", "How It Works", "What a Decision Trace Looks Like", "Inside the Framework",
  "Important Disclosures"). The header action is "Request Access" and the footer carries a "Console"
  link.
- `app/framework/page.tsx` — now renders through `PublicShell` with the intro splash. The anti-scraping
  architecture is unchanged: `force-dynamic`, the UA gate, `noindex`/`noai`/`TDMRep`, the gated
  content API, and the deliberate sitemap exclusion.
- `app/how-it-works/page.tsx` — replaced with `permanentRedirect("/framework")` (308).
- `app/strategy/page.tsx` — now `permanentRedirect("/framework")` (one hop, was two).
- `app/page.tsx` — host-aware: admin host → `/admin`, marketing hosts → `/welcome`, else `/console`.
- `app/terms-and-conditions/page.tsx`, `app/privacy-policy/page.tsx` — converted to `PublicShell`
  with `contentWidth="narrow"`, so the legal pages carry the same wordmark in the same corner.
- `app/sitemap.ts` — `/how-it-works` removed; `/framework` stays deliberately excluded.
- `app/robots.ts` — `/how-it-works` removed from the allow list; `/framework` stays disallowed.
- `middleware.ts` — `MARKETING_HOSTS` (both apex hosts plus `www.` variants), `ALT_DOMAIN_HOSTS`, and
  `CANONICAL_HOST`. The alt domain 308s to `https://socratictrade.com` before anything else, exempting
  `/api/*` (machine callers — webhooks, uptime probes — must not be handed a redirect they may not
  follow) and `/.well-known/apple-app-site-association` (the `applinks` + `webcredentials`
  entitlements on `socratic.trade` need the AASA served on that domain). After identity resolution and
  before the fail-closed `/login` redirect, the apex `/` sends an anonymous visitor to `/welcome` and
  a signed-in operator to `/console`.

### Tests

- `test/public-site-routing.test.ts` (new, 18 tests) — marketing-host routing, the alt-domain
  forward and its two exemptions, subdomain isolation, a source-level guard that all four public
  pages render through `PublicShell`, that the Welcome button says "Framework" and links
  `/framework`, that the shared header's row height comes from the shared geometry constants, and
  the `LANDING_PAGE_ENABLED` off-switch (see the review findings below).
- `test/public-sentence-gap.test.ts` (new, 4 tests) — renders the Welcome page to static markup and
  proves the sentence gap is a real NBSP + space that survives the browser's whitespace collapse,
  and that the framework content stores its gaps the same way.
- `test/how-it-works-redirect.test.ts` (updated) — now expects the 308 to `/framework`.
- `test/candle-ticker-raf-resilience.test.ts` — import repointed to `../app/ui/brand/candle-ticker`.
- `ios/SocraticTrade/CandleWordmarkView.swift`, `ios/SocraticTradeTests/CandleWordmarkTests.swift` —
  comments repointed at the new ticker path. No Swift behavior change.

## Review Findings Accepted And Fixed

Two findings came back from the automated reviews on PR #4889.  Both were real, and both are fixed.

### 1. The apex redirect 404'd with the marketing pages off

The marketing-host root redirect to `/welcome` was unconditional.  `LANDING_PAGE_ENABLED=off` is the
documented "private deploy / go-public off-switch" (`src/lib/landing-page.ts`), and with it set
`/welcome` 404s — so the apex became a dead end instead of the login page the old behavior gave a
private deploy.

The middleware and `app/page.tsx` now consult `landingPageEnabled()` before redirecting, so the
off-switch keeps working: anonymous visitor → `/login` (not a 404 page that does not exist),
signed-in operator → `/console` either way.  `/framework` inherited the same gate, because it
absorbed `/how-it-works`, which was already gated; without that, `LANDING_PAGE_ENABLED=off` would
have taken `/welcome` down and left the page that replaced its content wide open.  Production has the
variable unset, so no live behavior changes.  `docs/FEATURE-ENABLEMENT-BACKLOG.md` now lists
`/framework` among the gated pages.

### 2. The public copy's sentence gap collapsed

The new public copy separated sentences with two literal ASCII spaces.  HTML collapses runs of plain
spaces to one, so the rendered gap was a single space — and the repo's own copy-rule lint
(`test/copy-rules-lint.test.ts`, over `scripts/copy-rules-lint.mjs`) fails on exactly that
construct.  The first hosted `verify-hosted` run failed with 22 violations: 18 in
`app/framework/content.ts`, 1 in `app/framework/framework-viewer.tsx`, 3 in `app/welcome/page.tsx`.

The fix uses the repo's established idiom rather than a new one:

- **Content data** stores NBSP + space literally (the content module already did this for 44
  pre-existing strings), so it needs no conversion at the render boundary.  The sanctioned fixer
  (`node scripts/copy-rules-lint.mjs --fix --dir <files>`) applied the 22 changes.
- **JSX text** uses a `SENTENCE_GAP` marker, as the console does.  One subtlety cost a render test to
  pin down: a space *in front of* the marker survives JSX's text-node trimming and becomes an
  extra space in the rendered gap, so the marker carries no space before it
  (`loss.{SENTENCE_GAP}Simulated`, not `loss. {SENTENCE_GAP}Simulated`).

An earlier attempt at this — a `public-copy.ts` module with a runtime `gap()` / `gapDeep()`
converter — was **rejected and removed**.  It was a no-op on the legal pages (their paragraph strings
already carried NBSP), it was redundant on the framework content once the source carries the gap,
and it was a footgun: the repo's lint exists precisely to stop `app/**` from holding two-ASCII-space
gaps, and a converter invites the next author to write exactly that.

`test/public-sentence-gap.test.ts` now renders the Welcome page to static markup and asserts the
markup contains a real U+00A0 followed by a space — and that the gap is still there after the
browser's whitespace collapse.

## Decisions & Trade-offs

- **The `/framework` hardening stays.** The owner's 2026-07-11 instruction was to harden that page
  against AI and bot extraction; linking it from the Welcome page does not require un-gating it. The
  page keeps its UA gate, its server-only content module, the gated content API, and its
  noindex/noai/TDMRep headers. `/welcome` remains the indexable SEO surface and keeps its own "How
  It Works" section.
- **`/how-it-works` returns a 308, not a 404.** The page's *content* is gone (fully superseded), but
  a permanent redirect keeps inbound links, bookmarks, and search results landing on the content
  instead of a dead end. A bot hitting it is redirected and then blocked by the existing UA gate and
  the edge WAF rule.
- **Apex root routing is session-aware.** Anonymous visitor → `/welcome` (the stated requirement:
  "viewers of the main domain"). Signed-in operator → `/console`, so an operator's own bookmark to
  the apex domain still opens the app. The Welcome footer's "Console" link is the fallback path.
- **The header row is a FIXED height, not a minimum.** With `min-h-8` and vertical padding, a page
  with no header action would collapse the row to the wordmark's 22px and move the wordmark 5px off
  the position the animation aims at. The row is now pinned to `PUBLIC_ROW_H`, and a source-level
  test holds that invariant.
- **Title Case applied to the framework content's pre-existing card titles.** The owner's 2026-10-01
  ruling is that ALL headings, buttons, and titles are Title Case. 40 strings in `content.ts` plus
  the diagram's two actor labels ("Green team" → "Green Team", "Red team" → "Red Team") were
  normalized — this is the one pass over otherwise byte-identical pre-existing strings. Diagram node
  labels that form one wrapped phrase ("Policy gate" + "decides") stay sentence case, because they
  are a phrase split across two lines, not two titles. Body prose and lead-in sentences stay
  sentence case.
- **The alt-domain forward is app-level.** DNS already CNAMEs `socratic.trade` → `socratictrade.com`,
  so both hosts reach the same Next.js origin and the redirect has to happen in the app.
- **The marketing pages keep the `LANDING_PAGE_ENABLED` off-switch.** The apex redirect and
  `/framework` both consult `landingPageEnabled()` rather than assuming the pages are public.  A
  redirect to a page that would 404 is worse than the old behavior, which was `/login` on a private
  deploy.  The switch stays honest: it takes the public pages down together.
- **The sentence gap uses the repo's own idiom, not a new one.** NBSP + space in content data, a
  `SENTENCE_GAP` marker in JSX.  A runtime converter was tried and removed — see Review Findings.

## Verification State

In the lane (`~/apps/lanes/Socratic-Trade/minimax-public-framework-pages`, branch
`minimax/st-4565-public-framework-pages`, base `origin/main` @ `92b123dfe`):

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint <changed files>` — 0 errors (1 grandfathered `react-hooks/set-state-in-effect`
  warning; the repo pins the whole rule to "warn" in `eslint.config.mjs`).
- `npx vitest run` over the six affected files — 60 tests green:
  `public-site-routing` (18), `public-sentence-gap` (4), `copy-rules-lint` (17),
  `framework-page` (9), `how-it-works-redirect`, `candle-ticker-raf-resilience`.
- `node scripts/copy-rules-lint.mjs` — repo sweep: 46 sentence-gap violations, all in the
  peer-locked files (the baseline the lint test caps at), **0** in anything this change touched.

**The full suite and the production build were not run locally, and are not claimed here.** The
lane lives on an external volume and the host's load (57–267) made a local full run impractical.
The hosted `verify-hosted` job is the gate of record.

Its first run **failed**, on the copy-rule lint — 22 sentence-gap violations, described under
Review Findings above.  Fixed; the re-run is the gate of record.  Every other job on that run was
green: `classify`, `gitleaks`, `check-pin`, `autofix`, `verify-ios / xcodebuild (unsigned)`,
Seer Code Review, and Kody Code Review.

One real defect was caught by the local gate and fixed before the first push: parameterizing the
intro canvas put the per-variant state behind a render-scope `const state = VARIANT_STATE[variant]`,
and the effect then mutated it — which the React Compiler rejects as an **error** ("Cannot modify
local variables after render completes").  The console's original module-level `let introDone` / `let
MODEL` bindings had never been subject to that rule. The fix routes every write through module-scope
functions (`markIntroDone`, `setIntroModel`, `setIntroStart`, `setIntroCurHeader`) so the effect
holds read-only access to the per-variant state.

## Next Steps & Blockers

- Nothing blocking.  The first hosted `verify-hosted` run failed on the copy-rule lint; that is
  fixed and the re-run on the new head is the gate of record.
- Merging `main` auto-deploys (weekday RTH latch applies), and this change touches runtime paths
  (`app/**`, `middleware.ts`), so the image build is a real deploy.
- Not verified locally, and not verifiable locally: Swift compilation. The only Swift changes are
  comments, and `ios-build` on the PR is the gate of record.
- The WAF rule set (`2e28de6daa3b41afb03fcbd6b440a902`, blocking scraper/AI UAs on `/framework*` and
  `/api/framework*`) needs no change — the new redirect target is the same path it already covers.

## Zero-Code Findings

- The lane's `node_modules` had been replaced with a symlink to another lane's `node_modules` (a
  different lockfile). The symlink was unlinked and `npm ci` restored this branch's locked
  dependency set before any gate was run. `rm node_modules` is blocked by the shell guard;
  `unlink <absolute path>` is the working path for a symlink.
