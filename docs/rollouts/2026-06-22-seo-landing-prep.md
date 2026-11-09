# 2026-06-22 — SEO foundation + flag-gated landing page (launch prep)

## Summary

Prepared the app for a possible public launch **without exposing anything yet**: added an
SEO foundation that is **noindex by default**, and a compliant, education-led **landing
page** that is **off by default** (404 until a flag is set). Also captured the full
go-to-market research + decisions in `docs/go-to-market.md`. The owner may or may not go
public — every default here keeps the app private until explicitly flipped.

## Why

From the 2026-06-22 deep-research run: the product's "live-trading/investment service"
framing trips ad-platform bans and raises SEC/RIA exposure, while a research/paper/
education framing avoids both and unlocks the best awareness channels. Positioning
decision: market it as AI market-research / analytics / paper-trading, with live mode
present but never the headline. See `docs/go-to-market.md` and the `gtm-positioning-and-prep`
memory.

## Files

- `app/layout.tsx` — replaced the 2-line `metadata` with full SEO metadata: `metadataBase`
  (env `NEXT_PUBLIC_SITE_URL`, default `https://socratictrade.com`), title template,
  compliance-safe description, keywords, canonical, OpenGraph, Twitter, and **env-gated
  robots** (noindex/nofollow unless `NEXT_PUBLIC_ALLOW_INDEXING=true`). `viewport` + layout
  body unchanged.
- `app/robots.ts` (new) — disallow-all by default; when `NEXT_PUBLIC_ALLOW_INDEXING=true`,
  allow only `/welcome`, disallow `/`, `/api/`, `/access-denied`, and point to the sitemap.
- `app/sitemap.ts` (new) — single `/welcome` entry (the app itself is gated).
- `app/welcome/page.tsx` (new) — flag-gated server component
  (`LANDING_PAGE_ENABLED !== "true"` → `notFound()`); hero, features grid, how-it-works,
  prominent **disclosures** card (not investment advice / not a broker-dealer or RIA / risk
  of loss / simulated ≠ future results / consult a pro), footer, JSON-LD
  (`SoftwareApplication`). Uses `Button`/`Card` primitives + design tokens. Page-level
  metadata with the same env-gated robots.
- `middleware.ts` — added `"/welcome"` to `PUBLIC_PREFIXES` (reachable without auth when
  enabled; 404s when the flag is off regardless).
- `.env.example` — documented `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ALLOW_INDEXING`,
  `LANDING_PAGE_ENABLED` (all default to the private/safe state).
- `docs/go-to-market.md` (new) — research synthesis, verified ad/SEO/compliance
  constraints, 30-day playbook, done/partial/deferred checklist, sources.

Build delegated to a Sonnet subagent (cheapest model that does the job well); docs +
memory + verification + landing by the orchestrator.

## Verification

Isolated worktree `~/Code/agentic-trading-queue` off `origin/main`:
- `npx tsc --noEmit` — clean
- `npm test` (vitest) — **807 passed, 91 files**
- `npm run build` — green; static routes generated: `/welcome`, `/strategy`, `/robots.txt`, `/sitemap.xml`

## Follow-up additions (same day)

- **Button fix**: added `buttonClass()` to `app/ui/primitives.tsx`; the landing CTAs now use a
  styled `<a>` instead of a `<button>` nested in an `<a>`.
- **Paper-trading wording**: `app/welcome/page.tsx` + `app/layout.tsx` now describe paper trading
  as **via a third-party connection (e.g. Alpaca Paper Trading)**, and the landing notes the
  built-in local simulator ("Test — Local Sim") is less realistic than a connected paper account.
- **Strategy overview page**: new `app/strategy/page.tsx` (flag-gated + noindex, mirrors welcome),
  derived honestly from `docs/strategic-framework.md` (lenses, safety rules, learning loop, honest
  limitations, practice modes). Linked from the landing; `/strategy` added to `PUBLIC_PREFIXES`.

## Decisions / notes

- **Private by default** is deliberate: `LANDING_PAGE_ENABLED` off → `/welcome` 404s;
  `NEXT_PUBLIC_ALLOW_INDEXING` off → every page noindex + robots disallow-all. Go-public =
  flip those two (+ set `NEXT_PUBLIC_SITE_URL`) and submit the sitemap to Search Console.
- **No public demo built** — Test mode's simulator runs inside the authed app; a public
  no-signup demo needs an unauthenticated, sandboxed surface (auth + abuse controls), which
  exceeds the "super easy" bar. Documented as the biggest deferred awareness unlock.

## Follow-ups

- **Next PR — funded Test simulator** (per owner decision): make the Test broker a funded local
  simulator (simulated starting balance so it actually works), label "Test — Local Sim", and state
  in-app + docs that third-party paper (e.g. Alpaca) is likely more realistic than the local sim.
- Owner: securities-counsel review of RIA / SEC Marketing-Rule before any live-trading
  marketing; verify Meta/X/Bing ad policies before spend; write SEO content (slow).
