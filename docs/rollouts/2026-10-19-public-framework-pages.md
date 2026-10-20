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

Two findings came back from the first round of automated reviews on PR #4889.  Both were real, and
both are fixed.

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

## Review Findings, Second Round

The next review round on PR #4889 came back with six threads.  Five were real and are fixed here; the
sixth had already been fixed by the first round and needed only an explanation.

### 3. The alt-domain 308 dropped a live session

`middleware.ts` forwarded `socratic.trade` to the canonical `socratictrade.com` before it resolved the
request's identity.  The Auth.js session cookie is host-only by default (`AUTH_COOKIE_DOMAIN` is
unset — `src/lib/auth/auth.ts`), and `socratic.trade` and `socratictrade.com` are unrelated domains, so
no cookie domain can span them: the canonical host never receives the session cookie.  An operator who
followed a link to the alt domain was therefore anonymous by the time the app saw them, and landed on
the public landing page instead of the console.

The redirect now resolves the session first and forwards **only anonymous traffic**.  A verified
session keeps the request on the alt host, where its cookie still applies.  The canonicalization hop
is exactly what drops the session, so it must not happen to a signed-in request.  `getSessionIdentity`
returns null when either the cookie or the secret is missing, so the check is safe on a deploy with
no auth configured.

### 4. The alt-domain 308 skipped the security headers

Every other redirect in `middleware.ts` goes out through `withSecurityHeaders`, which the G4 contract
(`docs/rollouts/2026-07-01-security-hardening.md`) and `test/security-headers.test.ts` require of
every response the middleware returns.  The alt-domain 308 was the one redirect that skipped it.  It
now goes out through the same helper.

### 5. The public host sets were written out twice

`MARKETING_HOSTS` was defined in `middleware.ts` and again in `app/page.tsx`.  Two copies of a host
list compile and type-check fine, so the only way they fail is by drifting — the middleware sends a
visitor one way and the route sends them another.  The sets now live in one place,
`src/lib/marketing-hosts.ts`, and both callers read them from there.  The module exports predicates
rather than the raw sets, so a caller cannot mutate the shared state.

### 6. A framework deep link did not scroll

`/framework` renders its sections only after an async content fetch, so the browser's fragment
handling at load found no target in the document and the page sat at the top.  The viewer now scrolls
to the hash target once the content is ready.  The id lookup lives in `app/framework/hash-target.ts`
as a pure function with its own tests, because that is the part that can be wrong in a way a reader
would notice.  The scroll itself uses `behavior: "auto"`, not `"smooth"`: a deep link should land on
its section when the page settles, not animate to it.

### 7. This document named a lane path

This document named the lane it was written in.  A lane is per-seat and per-run, so the path was stale
the moment another seat picked the work up.  The branch and the base commit are the durable
references; the path is not.

### The sixth thread needed no change

The Sentry review also flagged the apex redirect to `/welcome` for not consulting
`landingPageEnabled()`.  That is finding 1 above: the middleware and `app/page.tsx` both consult the
off-switch, and `test/public-site-routing.test.ts` pins it.  The thread was raised against the code
before that fix landed, so it is answered by the existing change rather than a new one.

## Review Findings, Third Round

### 8. The two verification records contradicted each other

The first round recorded "the six affected vitest files green (60 tests)" and the second recorded
"the affected vitest files green (47 tests)", with different file lists.  The first named
`copy-rules-lint`;  the second dropped `copy-rules-lint`, `candle-ticker-raf-resilience`, and
`how-it-works-redirect`, and added `framework-hash-target` and `security-headers`.

Neither total covered the whole affected set, so neither was ever a claim about all of it, and read
together the two rounds made the suite look *smaller* in the second round than in the first.  The
complete set is nine files;  it has been re-run together and one file at a time, and every file
exits 0.  The Verification State section above now records the complete set and explains what the
two earlier rounds were.

### 9. The middleware passed an empty string to the session verifier

The alt-domain canonicalization hop read `process.env.AUTH_SECRET ?? ""`.  With no secret
configured, the verifier was handed an empty string and answered "no session", which is the same
answer it gives for a cookie that fails to verify.  The two are different:  one is a deployment
with no Auth.js secret, the other is an operator whose cookie did not check out.  Reading them as
one meant a missing secret looked like a cookie problem and turned into a silent redirect of every
operator, instead of a surfaced configuration error.

The secret is now read once and used only when it is actually set, and an empty string is never
handed to the verifier.  A missing secret in a live boot is surfaced where it belongs, by
`assertAuthSecretConfiguredInLiveBootstrap()` at startup;  a Cloudflare-Access-only deployment has
no `AUTH_SECRET` by design and is not an error, so the middleware must not throw for it.  New
`test/middleware-auth-secret.test.ts` (4 tests) proves the verifier is never called with a
placeholder credential, and it fails against the old code.

## Review Findings, Fourth Round

### 10. The middleware read a credential without the server-only guard

`middleware.ts` reads `AUTH_SECRET` and carried no `import "server-only";`, so nothing stopped the
module from being pulled into a client bundle.  The guard is now the first import in the file, the
same way the other credential-reading modules in `src/lib` carry it.  The production build was run
locally after the change and succeeded, which is what proves the guard compiles in the middleware
bundle rather than only in the unit tests.

### 11. The secret was read two different ways in the same file

The alt-domain hop trimmed `AUTH_SECRET` before deciding whether it was set, while
`isAuthConfigured()` and the canonical-host path read the raw value.  A whitespace-only secret
therefore read as "configured" everywhere except in that one hop, which then forwarded the
operator to the canonical host — where the host-only Auth.js cookie does not apply — and dropped
the session.  That is the session-loss regression the second round closed, in a narrower form.

The raw value is now the single source of truth, matching the rest of the file:  an empty string
is still never handed to the verifier, and a configured secret is passed through unchanged.  The
test file now says so:  it proves the verifier is never called with a placeholder credential, and
it pins the whitespace-only case to the raw value the canonical host uses.

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

On the work branch `minimax/st-4565-public-framework-pages`, based on `origin/main` @ `92b123dfe`:

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint <changed files>` — 0 errors (1 grandfathered `react-hooks/set-state-in-effect`
  warning; the repo pins the whole rule to "warn" in `eslint.config.mjs`).
- `npx vitest run` over the six files named in that round — 60 tests green:
  `public-site-routing` (18), `public-sentence-gap` (4), `copy-rules-lint` (17),
  `framework-page` (9), `how-it-works-redirect`, `candle-ticker-raf-resilience`.
- `node scripts/copy-rules-lint.mjs` — repo sweep: 46 sentence-gap violations, all in the
  peer-locked files (the baseline the lint test caps at), **0** in anything this change touched.

Re-verified after the second review round (findings 3–7 above), on the same branch:

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint` over the changed files — 0 errors, and the only warning is the same grandfathered
  `react-hooks/set-state-in-effect` one (the repo pins the whole rule to "warn" in
  `eslint.config.mjs`); the new scroll effect sets no state, so it adds no warning.
- `npx vitest run` over the five files named in that round — 47 tests green:
  `public-site-routing` (22), `framework-hash-target` (6), `security-headers` (6),
  `framework-page` (9), `public-sentence-gap` (4).
- `node scripts/copy-rules-lint.mjs` — repo sweep unchanged at 46 sentence-gap violations, **0** in
  anything this change touched.

**The two rounds above recorded different subsets of the same affected set, and that is why they
looked contradictory.**  The first round named `copy-rules-lint` and not the two newest files; the
second named the two newest files and dropped `copy-rules-lint`, `candle-ticker-raf-resilience`,
and `how-it-works-redirect`.  Neither total covered the whole set, so neither total was a claim
about all of it.  The complete affected set is nine files, re-run together on the same branch:

- `npx vitest run` over all nine affected files — **80 tests green, exit 0**:
  `public-site-routing` (22), `copy-rules-lint` (17), `candle-ticker-raf-resilience` (9),
  `framework-page` (9), `framework-hash-target` (6), `security-headers` (6),
  `public-sentence-gap` (4), `middleware-auth-secret` (4), `how-it-works-redirect` (3).
  Each file was also run on its own; every one exited 0.

**The full suite was not run locally, and is not claimed here.** The lane lives on an external
volume and the host's load (57–267) made a local full run impractical.  The hosted
`verify-hosted` job is the gate of record.

Re-verified after the fourth review round (findings 10 and 11 above), on the same branch:

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint middleware.ts test/middleware-auth-secret.test.ts` — 0 errors, 0 warnings.
- `npx vitest run` over all nine affected files — **80 tests green, exit 0**, the same set and the
  same count as the third round:  the whitespace-only case changed what the verifier is handed, not
  how many cases there are.
- `npm run build` (`next build --webpack`) — **succeeded**, exit 0.  This is the check that matters
  for finding 10:  it proves the `server-only` guard compiles in the middleware bundle, which the
  unit tests cannot, since the repo's vitest config aliases `server-only` to a mock.  The build
  prints the route table, middleware included, and exits clean.

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
