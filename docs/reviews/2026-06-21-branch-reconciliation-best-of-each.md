# Branch reconciliation — best of each

Main tip = `5d2d6a2` (origin/main). All unmerged branches diverge from a merge-base 16–41 commits behind main and were verified read-only via `git show`/`diff`/`log` + the per-area diff analyses below.

## TL;DR table

| Branch / area | Recommendation | Mutually-exclusive winner | One-line why |
|---|---|---|---|
| **agent/antigravity** — header/command-bar (`app/dashboard-client.tsx`, `app/ui/theme.tsx`) | **cherry-pick** (ideas only, re-apply on main) | **MAIN wins the structure**; antigravity wins responsive *sizing* | Wholesale reverts ~6 just-landed improvements; take only its sub-container grouping + `h-8…lg:h-9` sizing. |
| **agent/antigravity** — `app/api/connected-accounts/route.ts` Alpaca baseUrl auto-default | **drop** | n/a | Redundant with `alpaca.ts` `options.paper`; hardcoding the URL in DB is a fragile extra maintenance point. |
| **safety-quick-wins** — logos (`route.ts`, `ticker-logos.ts`) | **cherry-pick (take wholesale)** | **NOT mutually exclusive** — combine with main | Strictly additive logo.dev fallback; works *with* main's tile fix, not against it. |
| **safety-quick-wins** — backend (`AccountCapabilities` + two-layer short gate + CI) | **cherry-pick** (commit `d014842` + workflows `a5f3079`) | Not mutex (extends main's short branches) | High-value safety; additive-only gate; CI files need `workflow` token scope. |
| **chore/safety-quick-wins** — SQLite/LLM hardening | **cherry-pick** (commit `877bb45`) | Not mutex | Surgical, non-overlapping hunks; fixes a real `\n` prompt-corruption bug. |
| **feat/tuner-missed-opportunities** | **take-wholesale** (commit `6fa51b5`) | Not mutex | Conflict-free; `strategy-tuning.ts` byte-identical at base and main tip. |
| **agent/codex** | **drop / delete branch** | n/a | Diff is exactly one self-labeled "DO NOT MERGE" docs file. |
| **dependabot** — eslint, @types/node, lucide-react | **adopt** (with tsc verify) | n/a | Safe; eslint not in verify trio, icon/type surface stable. |
| **dependabot** — zod, next | **hold** | n/a | zod needs `npm ls` check; next 16 needs a coordinated `next.config.ts` migration. |

## Mutually-exclusive resolutions

### HEADER — agent/antigravity vs main → **MAIN wins structure; antigravity wins sizing ideas (cherry-pick onto main, do NOT take the commit)**

antigravity's single commit (`4078cd5`, now part of tip `c88d360`) was built 16 commits behind main and predates PR#10, the UI/UX audit, and PR#12. Taking it wholesale would **silently revert six deliberate, just-landed changes**:

1. **iPad cockpit shell `lg`→`xl` regression** — main moved the shell `dvh`/overflow, body grid `lg:grid-cols-[320px_minmax(0,1fr)]`, `aside lg:block`, and tabpanel scroll from `xl:` to `lg:` so iPad-landscape (~1024px) gets the two-column rail. antigravity reverts all of these back to `xl:`. **Keep main.**
2. **Header min-height** — main uses `min-h-16`/`xl:min-h-16` (PR#10 fix for clipped header); antigravity reverts to fixed `min-h-14`/`xl:h-14`. **Keep main.**
3. **`executionTone()` + third brand-block status dot** — main commit `3305107` (PR#10) deleted both as redundant with the tri-state safety banner; antigravity re-adds both. **Keep main (do not re-add).**
4. **aria-labels** — main's audit added `aria-label="Approval mode"` (Mode select) and `aria-label="Active account"` (Account select); antigravity removes them. **Keep main; re-add explicitly if applying antigravity's sub-container markup.**
5. **Removed Test-Mode status line** — PR#12/PR#10 trim; antigravity's older base reintroduces clutter. **Keep main.**

**What to actually take from antigravity** (re-apply by hand on current main; do NOT `cherry-pick 4078cd5`):
- **Two-sub-container header split** (antigravity `dashboard-client.tsx` ~line 542): replace the single flat `flex-wrap` right-side container with `flex-col items-end gap-1.5 … md:flex-row md:items-center md:justify-end` plus two logical groups (group 1: Mode + Account + Refresh + Settings + ThemeToggle; group 2: Activity + Flow + Strategy + Run once + Start/Stop). Cleanest improvement in the diff — gives ~2–3 predictable rows at 390px instead of 4–5.
- **Responsive control sizing**: change fixed `h-9` controls to `h-8 … lg:h-9` with `text-xs/px-2` base → `text-sm/px-3` at `lg` across Mode pill, Account select (`max-w-[8rem]` at base vs main's `max-w-[13rem]` — saves ~80px), Refresh/Settings IconButtons (`h-8 w-8 lg:h-9 lg:w-9`), and the action buttons.
- **`theme.tsx` ThemeToggle**: adopt `h-8 w-8 lg:h-9 lg:w-9` to match.
- **Alpaca placeholder text** (1 line): update to `"e.g. https://paper-api.alpaca.markets/v2"`.

**IPH-5 note:** this is a *partial* fix only. IPH-5 ("header wraps to 3-4 rows on phones") was DEFERRED on main (`docs/reviews/2026-06-21-ui-ux-issue-register.md:101`) with the recommended fix being a `…` overflow popover below `sm`. Track the sub-container approach as an incremental step, not a closure.

### LOGOS — safety-quick-wins vs main → **NOT mutually exclusive; take BOTH (combine)**

These operate at different layers and are strictly additive:
- **Main** changed `app/ui/ticker-logo.tsx` (React tile style: `bg-slate-700` dark tile in light mode so white-glyph logos stay visible). **safety-quick-wins never touches this file — leave it exactly as-is.**
- **safety-quick-wins** changed the *server* pipeline: `app/api/logos/ticker/route.ts` (extracts a `fetchImage()` helper, then appends a logo.dev fallback tier gated on `LOGO_DEV_TOKEN`, plus a `fallback: "monogram"` letter-badge and a relaxed `image/*` content-type check) and `src/lib/ticker-logos.ts` (new `logoDevTickerUrl`/`logoDevDomainUrl`/`LogoDevOptions` exports).

The theming actually **aligns**: logo.dev defaults to `theme: "dark"`, and main's dark slate tile is exactly the canvas a dark-themed PNG wants. Risk is low — absent `LOGO_DEV_TOKEN`, the route falls through to 404 identically to main (pure no-op).

**Take wholesale:** `route.ts`, the `ticker-logos.ts` logo.dev block. **Do not touch** `ticker-logo.tsx`.

**Caveat — the +28-line `dashboard-client.tsx` hunk on this branch is NOT a logo change.** It's the `AccountCapabilities` badge renderer in `IntegrationsSection` and reads `acc.capabilities`. It cannot be cherry-picked in isolation (would be a TS error without the `AccountCapabilities` type + `capabilities?` field). Land it **only alongside** the backend AccountCapabilities feature below — not with the logo pick.

## Independent work to land

All three are additive and non-mutex with main and each other. The only shared file across them is `src/lib/strategy.ts`, and the hunks do not overlap.

1. **chore/safety hardening — `877bb45` (do first; smallest, highest pure-safety value).** `db.ts` `busy_timeout=5000`+`synchronous=NORMAL` (unit-paired); both Bull/Bear `JSON.parse` try/catch guards; `confidenceScore` schema `minimum:1/maximum:100` + `clampConfidence()`; and the `.join("\\n")`→`.join("\n")` bug (Bear prompt was being sent with literal backslash-n). Take all four code changes together. Skip the branch's docs — write a fresh rollout note.

2. **safety backend — `d014842` then workflows `a5f3079`.** `d014842` covers `types.ts` (`AccountCapabilities` + `capabilities?` field), `policy.ts` (OR-expands the short rejection to `!shortSellingEnabled || !brokerSupportsShort` — *extends* main's existing short/cover branches, doesn't replace them), `robinhood.ts`/`alpaca.ts` classifiers, two `strategy.ts` pass-through call sites, `db.ts` `capabilities` column migration + `parseCapabilities`, and **`test/policy.test.ts`** (rejection-message strings change `"is not supported"`→`"rejected: …"` — **must land with the policy change or CI breaks**). The logos `dashboard-client.tsx` capabilities-badge hunk rides here too. Then `a5f3079` for `.github/workflows/{ci,e2e,security}.yml`.

3. **tuner — `6fa51b5` (take-wholesale).** `strategy-tuning.ts` + new test. `strategy-tuning.ts` is byte-identical at merge-base and main tip → conflict-free three-way apply; deps (`getSkippedCandidateReturns` at `performance.ts:611`, `listMaturedSkippedCounterfactuals`) already on main. Bring its rollout doc along.

**Expected conflicts:** between #1 and #2 both touch `db.ts` and `strategy.ts`, but on different hunks (`db.ts`: pragmas ~L44 vs capabilities migration; `strategy.ts`: `proposeTrades`/`sanitizeProposals` ~L936–1404 vs two pass-through lines). Apply #1 first, then #2 — if `strategy.ts` line offsets shift, resolve trivially. #3 conflicts with nothing.

**Sequencing within strategy.ts:** apply `877bb45` before `d014842` so the larger hardening hunks land first and the two capabilities pass-through lines slot in cleanly afterward.

## Dependency bumps

| Bump | Verdict | Reasoning |
|---|---|---|
| **eslint 9.39→10.5** | **ADOPT** (low priority) | No eslint config committed; `next lint` not in verify trio. devDep-only, zero runtime/type impact. |
| **@types/node 22→26** | **ADOPT** | Pure devDep type bump. Gate with `npx tsc --noEmit` only. |
| **lucide-react 0.468→1.21 (MAJOR)** | **ADOPT** (verify) | All ~23 imported icon names confirmed present under identical PascalCase in 1.21 dist; peer pin `^19.0.0-rc`→`^19.0.0` (React 19 already installed). MAJOR is cosmetic for this import surface — run tsc+test after. |
| **zod 3.25→4.4 (MAJOR)** | **HOLD** | Not imported anywhere in `src/`/`app/` source, but lives in `dependencies` (possible transitive consumer). Run `npm ls zod` first; v4 changed `z.ZodType` generics — adopt only after a full tsc+test pass. |
| **next 15.5→16.2 (MAJOR)** | **HOLD** | Branch bumps the version string only — no `next.config.ts` migration. Config uses `experimental.serverActions` (graduated in 16), a root `turbopack:{}` key, and a custom webpack callback w/ `serverExternalPackages`+alias — all areas Next 16 changed. Adopting as-is will likely break `npm run build`. Needs a dedicated migration PR. |

Safe apply order: eslint → @types/node → lucide-react → (zod after `npm ls`) → (next after config migration).

## Recommended integration order

Land independent, conflict-free work first; rebuild the header by hand last; defer the risky deps.

1. **tuner `6fa51b5`** — wholesale (cleanest; zero conflicts). Verify `npx tsc --noEmit && npm test`.
2. **chore/safety `877bb45`** — cherry-pick code only; write fresh rollout note. Re-verify.
3. **safety backend `d014842`** — cherry-pick (incl. `test/policy.test.ts` + the logos-branch capabilities badge hunk). Resolve any `db.ts`/`strategy.ts` offset nits. Re-verify.
4. **safety logos** (`route.ts` + `ticker-logos.ts` only; leave `ticker-logo.tsx`) — cherry-pick. Re-verify.
5. **CI workflows `a5f3079`** — land after the code; **requires a git token with the `workflow` OAuth scope** (the known STATUS.md push blocker — a credential issue, not a file-correctness issue).
6. **Header (antigravity ideas)** — hand-apply the sub-container split + `h-8…lg:h-9` sizing + ThemeToggle + Alpaca placeholder onto current main. Explicitly **preserve** main's `lg:` cockpit breakpoints, `min-h-16`, deleted `executionTone()`/third dot, and both aria-labels. **Drop** `connected-accounts/route.ts`. Re-verify; restart the PM2 preview after any `npm run build` (wipes `.next`).
7. **Deps**: eslint → @types/node → lucide-react (tsc+test each) → zod (after `npm ls zod`) → next (separate migration PR).
8. **agent/codex**: nothing to take — delete the branch (docs-only, self-labeled "DO NOT MERGE").

Run the full trio (`npx tsc --noEmit` → `npm test` → `npm run build`) after each of steps 1–6 since every branch is 16–41 commits behind and re-verification on the new base is mandatory.

## Risks & what NOT to do

- **Do NOT `git merge`/`cherry-pick 4078cd5` (antigravity) wholesale.** It silently reverts main's iPad `lg` cockpit shell, `min-h-16` header, the PR#10 `executionTone()`/third-dot deletion, both aria-labels, and the trimmed status line. This is the single biggest regression trap in the set.
- **Do NOT touch `app/ui/ticker-logo.tsx`** when taking the logo work. Main's `bg-slate-700` tile contrast fix must remain; the branch correctly never touches it and logo.dev's dark theme depends on it.
- **Do NOT cherry-pick the logos-branch `dashboard-client.tsx` capabilities hunk in isolation** — it needs the `AccountCapabilities` type + `capabilities?` field or it's a TS error. Bundle with `d014842`.
- **Do NOT land `policy.ts` short-gate without `test/policy.test.ts`** — rejection strings changed (`"is not supported"`→`"rejected: …"`); splitting them breaks CI.
- **Do NOT adopt next 16 from the dependabot branch as-is** — no `next.config.ts` migration accompanies it; `npm run build` will likely fail.
- **Do NOT take the antigravity `connected-accounts/route.ts` Alpaca baseUrl auto-default** — redundant with `alpaca.ts options.paper` and creates a stale-URL maintenance hazard in the DB.
- **Do NOT treat the header cherry-pick as closing IPH-5** — it's a partial improvement; the deferred `…`-popover fix still stands.
- **Do NOT skip re-verification** after each pick: branches are 16–41 commits stale, and `tsc --noEmit` can fail on missing `.next/types/**` — a fresh `npm run build` is the authoritative regen step before re-checking.

Key file refs: `app/dashboard-client.tsx` (header ~L532–648 / IntegrationsSection ~L3051), `app/ui/theme.tsx` (ThemeToggle), `app/ui/ticker-logo.tsx` (main tile — keep), `app/api/logos/ticker/route.ts`, `src/lib/ticker-logos.ts`, `src/lib/{types,policy,robinhood,alpaca,strategy,db}.ts`, `test/policy.test.ts`, `src/lib/strategy-tuning.ts`, `docs/reviews/2026-06-21-ui-ux-issue-register.md:101` (IPH-5).