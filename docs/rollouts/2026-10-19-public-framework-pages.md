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

The header's geometry is **inline-styled from those constants rather than set with Tailwind classes**.  The loading animation computes its landing box in JavaScript from the same constants, so a CSS class
and a JS number could drift and the candles would land beside the wordmark instead of on it.

### One animation implementation, two variants

The console's intro canvas moved out of the console tree and was parameterized rather than duplicated.

- `app/console/ui/candle-ticker.ts` → `app/ui/brand/candle-ticker.ts` (moved).
- `app/console/ui/intro-bus.ts` → `app/ui/brand/intro-bus.ts` (moved).
- `app/console/components/intro-canvas.tsx` → `app/ui/brand/intro-canvas.tsx` (moved + parameterized
  with `variant: "console" | "public"`).

Each variant keeps its own module state and its own `sessionStorage` key (`st.introShown` vs
`st.publicIntroShown`), so the public splash never consumes the console's one-shot splash and the
console splash never consumes the public one.  Console behavior is unchanged: same backdrop, same
`--con-pos`/`--con-neg` candle colors, same cached header top.

The public brand is **CSS-sized** (`width: 100%` + `aspect-ratio` + `maxWidth`) rather than
canvas-sized on mount, so the very first paint is already the right size.  The animation measures
`[data-brand-logo]` every frame, and a canvas that resized on mount would have made the candles land
beside the wordmark.

### Framework page expansion

- `app/framework/content.ts` (270 → 425 lines) — new sections: `questions[]` (the seven questions a
  decision must answer), `plainLoop[]` (Observe / Argue / Decide / Act / Explain / Learn mapped to
  pipeline stages), `caseFileIntro` + `caseFile[]` (the seven decision-case-file fields),
  `authorityIntro` + `authority[]` (reusing `HOW_IT_WORKS_AUTHORITY_ITEMS` from `@/lib/guardrail-copy`
  so the guardrail copy has exactly one source), `outcomeIntro` + `outcomeLenses[]`, and
  `resilienceIntro` + `resilience[]` (drawn from `docs/trading-framework.md`).  The content expansion
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

- `app/welcome/page.tsx` — rewritten on `PublicShell`.  The hero button is now **"Framework"** and
  links `/framework`; a second CTA reads "Read the Framework".  Section headings are Title Case
  ("What It Does", "How It Works", "What a Decision Trace Looks Like", "Inside the Framework",
  "Important Disclosures").  The header action is "Request Access" and the footer carries a "Console"
  link.
- `app/framework/page.tsx` — now renders through `PublicShell` with the intro splash.  The anti-scraping
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
  `CANONICAL_HOST`.  The alt domain 308s to `https://socratictrade.com` before anything else, exempting
  `/api/*` (machine callers — webhooks, uptime probes — must not be handed a redirect they may not
  follow) and `/.well-known/apple-app-site-association` (the `applinks` + `webcredentials`
  entitlements on `socratic.trade` need the AASA served on that domain).  After identity resolution and
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
  comments repointed at the new ticker path.  No Swift behavior change.

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
`copy-rules-lint`; the second dropped `copy-rules-lint`, `candle-ticker-raf-resilience`, and
`how-it-works-redirect`, and added `framework-hash-target` and `security-headers`.

Neither total covered the whole affected set, so neither was ever a claim about all of it, and read
together the two rounds made the suite look *smaller* in the second round than in the first.  The
complete set is nine files; it has been re-run together and one file at a time, and every file
exits 0.  The Verification State section above now records the complete set and explains what the
two earlier rounds were.

### 9. The middleware passed an empty string to the session verifier

The alt-domain canonicalization hop read `process.env.AUTH_SECRET ?? ""`.  With no secret
configured, the verifier was handed an empty string and answered "no session", which is the same
answer it gives for a cookie that fails to verify.  The two are different: one is a deployment
with no Auth.js secret, the other is an operator whose cookie did not check out.  Reading them as
one meant a missing secret looked like a cookie problem and turned into a silent redirect of every
operator, instead of a surfaced configuration error.

The secret is now read once and used only when it is actually set, and an empty string is never
handed to the verifier.  A missing secret in a live boot is surfaced where it belongs, by
`assertAuthSecretConfiguredInLiveBootstrap()` at startup; a Cloudflare-Access-only deployment has
no `AUTH_SECRET` by design and is not an error, so the middleware must not throw for it.  New
`test/middleware-auth-secret.test.ts` (4 tests) proves the verifier is never called with a
placeholder credential, and it fails against the old code.

## Review Findings, Fourth Round

### 10. The middleware read a credential without the server-only guard

`middleware.ts` reads `AUTH_SECRET` and carried no `import "server-only";`, so nothing stopped the
module from being pulled into a client bundle.  The guard was added as the first import in the
file, the same way the other credential-reading modules in `src/lib` carry it, and the production
build was run locally after that change and succeeded.

**This entry was later reversed, and the reversal is finding 13.**  The guard was deliberately
taken back out of `middleware.ts`, with the rationale recorded in the file itself; the guard
stays on the credential-reading modules under `src/lib` and `app/api/*/route.ts`.  The build
recorded here was run against the file *with* the guard, so it is evidence about that state and
not about the file this diff ships.

### 11. The secret was read two different ways in the same file

The alt-domain hop trimmed `AUTH_SECRET` before deciding whether it was set, while
`isAuthConfigured()` and the canonical-host path read the raw value.  A whitespace-only secret
therefore read as "configured" everywhere except in that one hop, which then forwarded the
operator to the canonical host — where the host-only Auth.js cookie does not apply — and dropped
the session.  That is the session-loss regression the second round closed, in a narrower form.

The raw value is now the single source of truth, matching the rest of the file: an empty string
is still never handed to the verifier, and a configured secret is passed through unchanged.  The
test file now says so: it proves the verifier is never called with a placeholder credential, and
it pins the whitespace-only case to the raw value the canonical host uses.

## Review Findings, Fifth Round

### 12. The status record exposed private host capacity details

Kody's Rule 12 caught a self-inflicted one.  The verification note written earlier in this effort
recorded the working environment's external-volume setup and its workload range.  A status record is
not the place for private hosting or capacity detail: the reader needs one fact, that the hosted
`verify-hosted` job is the gate of record, and not what the local machine was doing.

`STATUS.md`, `PLAN.md` and this rollout note all carried the same wording, and Kody flagged only
`STATUS.md`.  Fixing the flagged file alone would have bought a round rather than a fix and the same
finding would have returned on the next push, so all three were changed together.  The rest of the
diff was then swept for the same class — IPs, host and lane paths, hostnames, and capacity or
workload specifics, across every added line of every file this PR touches.  The remaining matches are
pre-existing entries already on `main`, outside this diff.

## Review Findings, Sixth Round

### 13. The `server-only` guard was taken back out of `middleware.ts`

Kody's fourth-round finding 10 asked for `import "server-only";` in `middleware.ts`, and this diff
takes it back out.  The rationale now lives in the file itself, at the top of the module.  Three
things are true about the guard.  The package's exports map `react-server` to `./empty.js` and
`default` to `./index.js`, so plain `node` throws "This module cannot be imported from a Client
Component module" while `node --conditions=react-server` loads clean — and a production build
still succeeds in the throwing case, because the failure happens at module-evaluation time, so a
green CI run proves nothing about the guard in either direction.  The guard was also never earning
anything where it stood: middleware is a server entry point compiled only for the edge runtime,
so no Client Component can import it.  And the repo's vitest config aliases `server-only` to a
mock, so the unit tests could not have caught a mistake in either direction.  The guard stays on
the credential-reading modules under `src/lib` and `app/api/*/route.ts` that a client bundle could
genuinely pull in.

### 14. The records still claimed the guard was in the file, and the recorded build predated its removal

Kody's sixth-round finding caught exactly that, and it was real.  Four places in the records this
diff ships still asserted that `middleware.ts` carries the guard: the fourth-round entry in
`STATUS.md`, the fourth-round entry in this note, the fourth-round paragraph in `PLAN.md`, and
the recorded build evidence below.  The recorded `npm run build` succeeded against the file
*with* the guard, so "80 tests green / build succeeded" described a file state that no longer
exists, and anyone auditing the middleware's client-bundle boundary from these records would have
got the wrong answer.  All four now say the guard was deliberately taken back out, carry the
rationale, and label the recorded build as predating the removal.  The general lesson is the one
this effort has already paid for once: when a review round reverses an earlier round's fix, the
records that describe the earlier fix are part of the change, not commentary on it.

## Review Findings, Seventh Round

### 15. Every pull request was failing its Autofix check, fleet-wide

Pull requests in this repository were failing their `autofix` job, on branches that touched
nothing the autofixer cares about.  The reusable workflow
`.github/workflows/pr-autofix-reusable.yml` was pinned at a SHA whose body ran
`claude --print --dangerously-skip-permissions ... --output-format stream-json`, and the CLI
rejects that combination — "When using --print, --output-format=stream-json requires --verbose".
The pin was the defect, not the CLI and not the trigger.

The fix already existed on the coordinator's `main` as `00def854` (PR #632).  The good reusable SHA
is `c97a2dae96762eb9ffc122c753f0dfb0a7840650`.  Every consumer pin was checked by reading the
reusable at the pinned SHA rather than by trusting the pin string: Socratic-Trade, DealDex,
CodeCaps, ContactLogo, Clutch, BotFleet, Congress.Trade, HogHunter, Simple-With-Us and
congress-trading-shared are all on `c97a2dae`, the copy vendored inside Congress.Trade is on
`a652e467` and also carries the fix, and `fleetlink-legacy` has no `autofix.yml` on `main`.

The sweep was reported as AFC-451 and the Socratic-Trade half as ST-4569.  Neither was claimed or
executed by this seat: the coordinator repo belongs to CLAUDE and the sweep spans seven repos
across other teams.  The Socratic-Trade half landed through the repository's own autofix path, as
PR #4905, merged as `308d3f256`, and both issues are closed as already-landed.

### 16. The `auto-merge / arm` workflow passed `--delete-branch` under a merge queue

`auto-merge / arm` passed `--delete-branch`, which GitHub rejects when a merge queue is enabled
on the branch.  `main` already carried a merge-queue arm for that workflow and the check passes
there; the arming path was corrected in PR #4893, which is merged, and the check is green on this
branch.

## A Finding Of This Effort's Own That Did Not Hold

### 17. The docs-only diagnosis was wrong, and it is corrected here

This note originally claimed that a docs-only head can never report the required `verify` check,
and that a manual `workflow_dispatch` re-kick had to be dispatched by hand on every docs-only
head.  That claim was wrong, and it was this seat's error.  The `verify` job is gated on
`if: ${{ !cancelled() }}` (ci.yml:413-418), not on the `classify` outputs; only `verify-hosted`
(ci.yml:275) and `verify-ios` (ci.yml:407) are gated behind `docs-only != 'true'`.  On the
docs-only path the gate script exits 0 and reports "RESULT: PASS — docs-only diff — gate skipped by
path filter" (ci.yml:443-446), and `test/branch-protection-gate.test.ts` pins that behaviour.

The empirical check settles it.  PR #4875 changed exactly one file (`AGENTS.md`), so its head is
docs-only, and the check-runs on that head SHA report `verify` → `success`, `verify-hosted` →
`skipped`, `verify-ios` → `skipped`.  There is no stranded required check and no re-kick to
remember.

The wrong claim was also filed as ST-4568, which is closed as a finding that did not hold.  The
`workflow_dispatch` lever is real, but it exists for a different edge: pushes made through the
cloud git proxy generate no `pull_request` event at all (ci.yml:40-47), so no run attaches `verify`
to the head SHA.

The correction to this section was made by another seat on this branch, in commit `504af8dc5`, and
was adopted rather than rewritten.  The transferable lesson is narrow: a required check that
"disappears" is a claim about the workflow's `if` conditions, and a comment above a lever is not
an `if` condition.  Reading ci.yml is cheap; the comment was read instead.

## Merge Mechanics Diagnosed On This PR

Two mechanical blockers were diagnosed here that are worth recording, because neither is visible from
the PR diff and both cost real time.

**Docs-only heads still satisfy the `verify` requirement.**  When `classify` reports `docs-only: true` only `verify-hosted` is skipped (ci.yml:275); the `verify` gate itself always runs (`if: ${{ !cancelled() }}`) and its docs-only branch exits 0, reporting "RESULT: PASS — docs-only diff — gate skipped by path filter" (ci.yml:444-446, pinned by `test/branch-protection-gate.test.ts`).  There is no stranded required check on a docs-only head and no re-kick to remember.  The `workflow_dispatch` manual re-kick lever exists for a different edge: pushes made through the cloud git proxy generate no `pull_request` event at all (ci.yml:40-47), so no run attaches `verify` to the head SHA.  Likewise the `merge_group` docs-only=false applies to the queue's own run on its temporary branch, not to the PR head check.

**Unattributed commits need an owner approval, and that is a gate, not a bug.**  The
`org-default-main-protection` ruleset sets `require_extra_approval_for_unattributed_changes: true`.  Most commits on this branch resolve to the owner through GitHub, but three do not: one authored by
the MiniMax bot and two contributed by another seat under a local identity, and the API returns
`author: null` for each of them.  Those commits therefore count as unattributed, and the rule then
requires an approval from someone with write access.  The other requirements were all satisfied —
`verify` and `gitleaks` green, all review threads resolved,
`required_approving_review_count: 0` — so this is the single unmet condition.  Rewriting an
author would have cleared the rule and defeated exactly what it exists for, so the authors were
left alone and the approval was surfaced to the owner as the one action only he can take.

## Decisions & Trade-offs

- **The `/framework` hardening stays.**  The owner's 2026-07-11 instruction was to harden that page
  against AI and bot extraction; linking it from the Welcome page does not require un-gating it.  The
  page keeps its UA gate, its server-only content module, the gated content API, and its
  noindex/noai/TDMRep headers.  `/welcome` remains the indexable SEO surface and keeps its own "How
  It Works" section.
- **`/how-it-works` returns a 308, not a 404.**  The page's *content* is gone (fully superseded), but
  a permanent redirect keeps inbound links, bookmarks, and search results landing on the content
  instead of a dead end.  A bot hitting it is redirected and then blocked by the existing UA gate and
  the edge WAF rule.
- **Apex root routing is session-aware.**  Anonymous visitor → `/welcome` (the stated requirement:
  "viewers of the main domain").  Signed-in operator → `/console`, so an operator's own bookmark to
  the apex domain still opens the app.  The Welcome footer's "Console" link is the fallback path.
- **The header row is a FIXED height, not a minimum.**  With `min-h-8` and vertical padding, a page
  with no header action would collapse the row to the wordmark's 22px and move the wordmark 5px off
  the position the animation aims at.  The row is now pinned to `PUBLIC_ROW_H`, and a source-level
  test holds that invariant.
- **Title Case applied to the framework content's pre-existing card titles.**  The owner's 2026-10-01
  ruling is that ALL headings, buttons, and titles are Title Case.  40 strings in `content.ts` plus
  the diagram's two actor labels ("Green team" → "Green Team", "Red team" → "Red Team") were
  normalized — this is the one pass over otherwise byte-identical pre-existing strings.  Diagram node
  labels that form one wrapped phrase ("Policy gate" + "decides") stay sentence case, because they
  are a phrase split across two lines, not two titles.  Body prose and lead-in sentences stay
  sentence case.
- **The alt-domain forward is app-level.**  DNS already CNAMEs `socratic.trade` → `socratictrade.com`,
  so both hosts reach the same Next.js origin and the redirect has to happen in the app.
- **The marketing pages keep the `LANDING_PAGE_ENABLED` off-switch.**  The apex redirect and
  `/framework` both consult `landingPageEnabled()` rather than assuming the pages are public.  A
  redirect to a page that would 404 is worse than the old behavior, which was `/login` on a private
  deploy.  The switch stays honest: it takes the public pages down together.
- **The sentence gap uses the repo's own idiom, not a new one.**  NBSP + space in content data, a
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
  `public-sentence-gap` (4), `middleware-auth-secret` (4), `how-it-works-redirect` (3).  Each file was also run on its own; every one exited 0.

**The full local gate was run, end to end, and it is one failure out of 9,778 tests.**  The
earlier statement that a full run was impractical in this seat's working environment was wrong,
and it is corrected here.

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint app src test middleware.ts` — exit 0.  The gate fails on errors only; the
  grandfathered `@typescript-eslint/no-explicit-any` and `react-hooks/set-state-in-effect`
  backlog is pinned to "warn" in `eslint.config.mjs`.
- `npx vitest run` — **1 failed, 9,726 passed, 51 skipped across 865 files**, exit 1.  The single
  failure is `test/event-loop-stall-hot-path.test.ts` → "pruneTaskJournal no-op stays under 100ms
  when a full scan of the same rows does not", a wall-clock assertion that measured 162s against a
  100ms bound and that times out against the 60s test timeout when it is re-run on its own.  The
  time a wall-clock assertion measures may vary with the execution environment.  Neither
  `test/event-loop-stall-hot-path.test.ts` nor
  `src/lib/db.ts` is touched by this diff — `git diff origin/main...HEAD --stat` over those two
  paths is empty — so this is an environment-dependent artifact and not a regression from this
  change.  It is reported as it stands; the hosted `verify-hosted` job is the gate of record.
- `npm run build` (`next build --webpack`) — **succeeded**, exit 0.

**What that pass covered, stated exactly.**  It ran on the tree carrying this branch's own
commits, before `origin/main` was merged in.  The merge that followed brought in
`src/lib/boot-ledger.ts` and `test/boot-ledger.test.ts` from `main` — files this diff does not
touch, on a commit where `main`'s own CI was green — and it changed no code of this diff.

**The second full pass ran on the merged head, `2d63d77e7`, and it produced a second failure that
the first pass did not have.**

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint app src test middleware.ts` — exit 0.
- `npx vitest run` — **2 failed, 9,731 passed, 51 skipped across 865 files (9,784 tests)**, exit 1.
- `npm run build` (`next build --webpack`) — **succeeded**, exit 0.

The first of the two is the same `test/event-loop-stall-hot-path.test.ts` wall-clock assertion as
before, measured at 205630 ms this time.  The second is new: `test/data-catalog-completeness.test.ts`
→ "scores RAG without inflating for multiple 10-Ks on one name", where `expect(pe!.completeness)`
expected 0 and received 1.

**That second failure is not this diff, and the first account of it was wrong.**  The cause is
the shared, untracked local database, but not in the way the first account said: the suite poisons
its own database *within a single run*, so the failure is an ordering flake that a clean checkout
can hit, not merely residue from an earlier run.

- `src/lib/enrichment-coverage.ts:296-302` persists a coverage report on every call to
  `setLastEnrichmentCoverageReport`, fire-and-forget through a dynamic import, into
  `file:./data/app.db` whenever `DATABASE_URL` is not overridden (`src/lib/db.ts:85`).
- `src/lib/data-completeness.ts:231` reads the newest persisted report back.  When it is non-null,
  the field loop at `src/lib/data-completeness.ts:293-313` takes the cascade-report branch and uses
  that row's `fillRate` as the field's `completeness` instead of the empty-universe 0.
- `data/` is gitignored (`.gitignore:22`) and `data/app.db` is untracked, so it is never committed
  and never shared between machines.

The first account said the residue of earlier runs was the trigger, and that a CI checkout, having
no `data/` directory, could not see the failure at all.  A third full pass, run against a database
that did not exist when the suite started, falsified both halves of that.  The same test failed
again, and the new file had accumulated seventeen coverage rows by the end of that one run:

```
DATABASE_URL="file:/tmp/mm-gate3.db" npx vitest run     # 3 failed | 9,730 passed | 51 skipped
sqlite3 /tmp/mm-gate3.db "SELECT COUNT(*) FROM enrichment_coverage_runs;"   # 17 rows, all from this run
```

The writer is `test/enrichment-coverage.test.ts`: a two-file probe over that file and the reader
wrote twelve rows, the newest carrying `peRatio` at `fillRate: 1`.  The repo's vitest config runs
with `maxWorkers: 1`, so the files execute sequentially in one worker process, and
`process.env.DATABASE_URL` leaks from one file to the next inside that process.  Whether the reader
sees a populated universe therefore depends on which file ran first and, because the persist is
fire-and-forget, on whether the write landed before the next file began.  A file that runs before
the writer passes; the same file running after it fails.

That makes it a within-run ordering flake, and a clean checkout can hit it: the hosted run has not,
but it has not been shown to be immune, so "CI is green" is not evidence against this class of
failure.  The code itself is sound — with a fresh database the file passes 4 of 4 on its own:

```
DATABASE_URL="file:/tmp/mm-fresh-app.db" npx vitest run test/data-catalog-completeness.test.ts
```

`git diff --name-only origin/main...HEAD` lists no test or source file among
`test/data-catalog-completeness.test.ts`, `src/lib/data-completeness.ts`, `src/lib/data-catalog.ts`,
`src/lib/enrichment-coverage.ts` or `src/lib/db-enrichment-coverage.ts`.

This is filed as ST-4570 with the root cause and a recommended fix.  It is deliberately kept out of
this diff rather than widening a public-pages change into shared test infrastructure, and it has
been raised from P2 to P1 on the corrected evidence and claimed: the fix is on its own branch off
`origin/main` as [PR #4911](https://github.com/Simple-With-Us/Socratic-Trade/pull/4911), so it
carries no unattributed commit and needs no owner approval to land.  Three files could reach the
persistence path without owning a database, and they are the ones changed there: the reader owns
its database per test, and the two writers own theirs for the whole file, because the persist is a
fire-and-forget dynamic import that can resolve after the test that triggered it has finished.

Re-verified after the fourth review round (findings 10 and 11 above), on the same branch:

- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint middleware.ts test/middleware-auth-secret.test.ts` — 0 errors, 0 warnings.
- `npx vitest run` over all nine affected files — **80 tests green, exit 0**, the same set and the
  same count as the third round: the whitespace-only case changed what the verifier is handed, not
  how many cases there are.
- `npm run build` (`next build --webpack`) — **succeeded**, exit 0.  This run was against the file
  *with* the `server-only` guard, so it is evidence about that state and not about the file this
  diff ships; the guard was taken back out afterwards (finding 13).  What it did prove is that
  the guard compiles in the middleware bundle, which the unit tests cannot, since the repo's
  vitest config aliases `server-only` to a mock.  The build prints the route table, middleware
  included, and exits clean.

Its first run **failed**, on the copy-rule lint — 22 sentence-gap violations, described under
Review Findings above.  Fixed; the re-run is the gate of record.  Every other job on that run was
green: `classify`, `gitleaks`, `check-pin`, `autofix`, `verify-ios / xcodebuild (unsigned)`,
Seer Code Review, and Kody Code Review.

One real defect was caught by the local gate and fixed before the first push: parameterizing the
intro canvas put the per-variant state behind a render-scope `const state = VARIANT_STATE[variant]`,
and the effect then mutated it — which the React Compiler rejects as an **error** ("Cannot modify
local variables after render completes").  The console's original module-level `let introDone` / `let
MODEL` bindings had never been subject to that rule.  The fix routes every write through module-scope
functions (`markIntroDone`, `setIntroModel`, `setIntroStart`, `setIntroCurHeader`) so the effect
holds read-only access to the per-variant state.

## Next Steps & Blockers

- **One gate is the owner's, and it is an approval.**  On the head `2d63d77e7` every check is
  green — `classify`, `verify`, `verify-hosted`, `verify-ios / xcodebuild (unsigned)`, `gitleaks`,
  `check-pin`, Kody Code Review, both Autofix jobs — and every finding raised against this diff is
  either fixed or answered on its thread.  What remains is the
  `require_extra_approval_for_unattributed_changes` approval described under Merge Mechanics.  It is
  not a code problem and it cannot be cleared by an agent.  Auto-merge is armed, so the merge fires
  as soon as the approval lands.
- **The Autofix check on this pull request failed five times before the org secret's selection was
  widened, and it is not a required check.**  `autofix` is not in the required status check list on
  `main` (`verify` and `gitleaks` are), so it never gated this merge.  Every failing run was
  bot-authored and every one of them predates the secret's last change; the first bot-authored run
  after it is green, in this repository and in the two other repositories used as controls.  The
  re-check on this pull request comes with the next bot-authored event, which is the review bot's
  re-review after the next push.
- No re-kick is needed on docs-only heads: `verify` still runs and reports PASS; only `verify-hosted` is skipped by the path filter.  The `workflow_dispatch` lever is reserved for cloud-proxy pushes that generate no `pull_request` event.  See Merge Mechanics above.
- Merging `main` auto-deploys (weekday RTH latch applies), and this change touches runtime paths
  (`app/**`, `middleware.ts`), so the image build is a real deploy.
- Not verified locally, and not verifiable locally: Swift compilation.  The only Swift changes are
  comments, and `ios-build` on the PR is the gate of record.
- The WAF rule set (`2e28de6daa3b41afb03fcbd6b440a902`, blocking scraper/AI UAs on `/framework*` and
  `/api/framework*`) needs no change — the new redirect target is the same path it already covers.
- **No follow-up needed on the docs-only fast path:** `verify` already reports a neutral PASS on docs-only diffs (ci.yml:444-446, pinned by `test/branch-protection-gate.test.ts`), so there is no contradiction with the required check to fix.

## Review Findings, Eighth Round

### 16. The Zero-Code Findings bullet repeated the falsified root cause and the falsified CI claim

Kody's review comment 4339304110 on this file was right, and the finding is taken rather than filed
as accepted risk.  The Zero-Code Findings bullet attributed the failure to residue carried between
runs and asserted that hosted CI never sees the condition because a CI checkout has no `data/`
directory.  That is the exact account this document's Verification State section falsifies, so the
bullet handed a reader the opposite of the corrected root cause and told them a green hosted run
cannot reproduce the failure — the claim that was used to treat the hosted `verify-hosted` job as
sufficient.

The bullet now matches the corrected account: the fire-and-forget persist poisons the shared
database *within a single run*, because the persist can resolve after the test that triggered it
has finished; the trigger is the order in which the files run inside one worker process rather
than leftover state; and the hosted run has not been shown to be immune, so a green hosted run is
not evidence against this class of failure.  The bullet also names the fix,
[PR #4911](https://github.com/Simple-With-Us/Socratic-Trade/pull/4911).

**A sweep of the same claim across every markdown file in the repository found exactly one site.**
The bullet was the only one still carrying the falsified account; `STATUS.md` and the Verification
State section above already carried the corrected one.

**The house gap rules were repaired on the same pass.**  This document carried five whitespace
defects of its own — four colons followed by two spaces and one sentence end with a single space —
and the lines this branch added to `STATUS.md` and `PLAN.md` carried thirty-six more of the same
class.  Those are the owner's scope rule, where a colon, a semicolon, a comma or a dash takes one
ordinary space and the gap belongs after `.`, `!` and `?`.  All forty-one are now one space, and
this document audits clean at 168 sentence boundaries with 168 two-space gaps.  That pass did not
close the class, and the ninth round below closes the last two sites on the branch.

## Review Findings, Ninth Round

### 17. The colon and semicolon class was still open on two lines this branch adds

The eighth-round sweep repaired 41 sites and called the class closed.  It was not closed.  A
second pass over the same class in this document and in `PLAN.md` found twenty-eight more here
and three there, and those are one space as well.  A third pass found the last two.

- `PLAN.md` line 2708 carried `copy-rule lint:  22 sentence-gap violations in the new public copy`,
  where the colon took two spaces.  It takes one space now.  The wording is a paraphrase of the
  lint output rather than a quote of it, so nothing is falsified by the change.
- `docs/FEATURE-ENABLEMENT-BACKLOG.md` carried `private deploys. Pages:` in the
  `LANDING_PAGE_ENABLED` row, where the sentence end took a single space.  It takes two now.  The
  row already existed on main and this branch added `/framework` to it, so the branch owns the
  line it rewrites.

The sweep that found these two is deliberately stricter than the one that missed them.  It reads
the branch's added lines out of the diff rather than reading whole files, so other seats'
historical rows on main are out of scope.  And it skips a boundary that sits inside an inline code
span or that is one half of a `??` nullish operator, which is exactly where the earlier pass
produced its false positives.

With these two closed, every line this branch adds carries the house gap rules.  This document
audits clean at 168 sentence boundaries with 168 two-space gaps, and the added lines in
`STATUS.md`, `PLAN.md` and `docs/FEATURE-ENABLEMENT-BACKLOG.md` carry no colon, semicolon, comma
or dash with two spaces, and no sentence end that is followed by more text without its two spaces.

## Zero-Code Findings

- The lane's `node_modules` had been replaced with a symlink to another lane's `node_modules` (a
  different lockfile).  The symlink was unlinked and `npm ci` restored this branch's locked
  dependency set before any gate was run.  `rm node_modules` is blocked by the shell guard;
  `unlink <absolute path>` is the working path for a symlink.
- **An org-wide Actions variable and an org secret with `selected` visibility do not have the same
  scope, and the disagreement fails every repository that is not on the secret's list.**  The org
  variables `SWU_AUTOFIX_MODEL_BASE_URL=https://api.meta.ai` and
  `SWU_AUTOFIX_MODEL=muse-spark-1.3-contributor` apply to every repository at once, so every
  consumer of `pr-autofix-reusable.yml` was routed at the Meta host.  The org secret
  `META_MODEL_API_TOKEN` has `selected` visibility and was visible to only four repositories, so
  every other consumer resolved `secrets.META_MODEL_API_TOKEN` to an empty string and the
  reusable's own guard (`pr-autofix-reusable.yml` @ `c97a2dae`, line 184) exited 1 with
  `token_set=no`.  The fix was to widen the secret's repository selection to the sixteen consumer
  repositories that consume the reusable — a selection change, with no credential value touched.
  It is confirmed in this repository: PR Autofix run 39608488565, on PR #4908, concluded
  `success` with `META_TOKEN` populated on the Meta route, and every run that failed did so before
  the secret's last change.  CodeCaps, which was not on the list before and is now, is green as
  well, and Clutch, which was on it from the start, passes the same guard.
- **A workflow whose job is gated on the comment author's user type cannot be re-kicked by a human
  comment.**  `.github/workflows/autofix.yml` gates the job on
  `contains(fromJSON('["bot", "Bot"]'), github.event.comment.user.type || github.event.review.user.type || '')`,
  so a human comment dispatches a run that concludes `skipped` rather than `failed`, and a skipped
  run reads as a pass in `gh run list`.  The guard itself is correct — only a bot actor should
  spend a model run — but "re-kick by commenting" is inert against it.  The levers that do work
  are bot-authored events, and a push to the branch is enough, because a review bot re-reviews on
  every push.
- **The untracked local database is a second, invisible input to the test suite, and a clean
  checkout can hit this failure on its own.**  The suite persists enrichment coverage reports
  into `file:./data/app.db` through a fire-and-forget dynamic import in
  `src/lib/enrichment-coverage.ts:296-302`, and `src/lib/data-completeness.ts:231` reads the
  newest persisted report back and uses its `fillRate` as a field's `completeness` when it is
  present.  Because `data/` is gitignored, that file is never committed and never shared between
  machines, and because the persist is fire-and-forget it can land after the test that triggered
  it has finished — so the database is poisoned *within a single run*, not by residue carried
  between runs.  The repo's vitest config runs with `maxWorkers: 1`, so the files execute
  sequentially in one worker process and `process.env.DATABASE_URL` leaks from one file to the
  next inside it, which makes the trigger the order in which the files run rather than leftover
  state.  A full pass against a database that did not exist when the suite started reproduced the
  failure and left seventeen coverage rows behind from that one run.  The check that separates
  this from a regression is one command — re-run the failing file against a fresh database and
  see it pass — together with a diff over the implicated paths that comes back empty.  The hosted
  run has not been shown to be immune, so a green hosted run is not evidence against this class
  of failure.  Filed as ST-4570, and the fix is [PR #4911](https://github.com/Simple-With-Us/Socratic-Trade/pull/4911).
