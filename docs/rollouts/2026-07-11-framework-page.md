# 2026-07-11 — Trading-framework doc + public /framework page with AI/bot-scrape hardening (CLAUDE)

## Summary

Owner-requested: a framework-level (not user/account-specific) explanation of the
entire trading pipeline, published at `socratictrade.com/framework`, hardened
against AI/bot content extraction.

Three deliverables:

1. **`docs/trading-framework.md`** (net-new — no prior `trading-framework*.md`
   existed): end-to-end architectural map of the trading machinery. Summary
   (8-stage pipeline) + detailed layers (market observation, evidence assembly,
   Socratic decision core, policy gate, execution, accounting, learning,
   autonomy, ops resilience), core invariants, honest-weaknesses section (per
   `strategic-framework.md`'s own rule), related-docs map. Explicitly does NOT
   supersede `strategic-framework.md` / `phase-7-strategy.md` /
   `single-adversary-consolidation.md` — it sits above them. Content was
   derived from an 11-subsystem parallel code-reading pass over the actual
   implementation (not from older docs), plus a completeness-critic pass that
   surfaced the event-trigger engine, the chat draft-to-proposal rail, and
   model rotation as gaps that were then folded in.
2. **Public page `app/framework/`** following the `how-it-works` page pattern
   (Card primitives, themed inline-SVG diagrams with horizontal/vertical
   responsive variants). Three diagrams: 8-stage pipeline loop, 7-layer
   architecture stack with learning feedback arrow, learning flywheel.
   Education-led framing + full disclosures per `docs/go-to-market.md`.
3. **Layered anti-scraping hardening** (see below).

## Anti-extraction hardening (layered)

The framework prose never appears in the page HTML **or any client JS chunk**:

- `app/framework/content.ts` is a server-only module; the client shell
  (`framework-viewer.tsx`) fetches it from `app/api/framework/content/route.ts`
  after passing browser checks (`navigator.webdriver` false, real UA, script
  execution proven by a timed fetch with a custom header).
- The content API answers only to requests carrying `x-framework-viewer: 1`
  AND same-origin fetch metadata (`sec-fetch-site`, when present) AND a
  non-blocked user agent — otherwise 404. Responses are `no-store`,
  `X-Robots-Tag: noindex... noai`, `tdm-reservation: 1`.
- `app/framework/ua-gate.ts`: shared UA blocklist (AI crawlers, SEO
  harvesters, HTTP libraries, headless automation) enforced by the page
  (`notFound()`) and the API. Kept in sync with the edge WAF rule.
- `app/robots.ts`: explicit disallow-all rules for ~30 AI crawler UAs in both
  indexing modes; `/framework` excluded from the allow list even when indexing
  is enabled. `/framework` is deliberately NOT in the sitemap and NOT linked
  from any public page.
- `next.config.mjs` `headers()`: `/framework` gets
  `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai`,
  no-store cache control, and `tdm-reservation: 1` (W3C TDMRep).
- Page metadata: full robots-noindex + `tdm-reservation` meta.
- **Cloudflare zone changes (already live, made via API this session):**
  - `ai_bots_protection: "block"` enabled on the socratictrade.com zone
    (blocks known AI crawlers zone-wide at the edge). Bot Fight Mode was
    deliberately NOT enabled — it would risk challenging the Congress.Trade
    webhook/SSE and ops-snapshot curl traffic.
  - New zone WAF custom ruleset (id `2e28de6daa3b41afb03fcbd6b440a902`, phase
    `http_request_firewall_custom`) with one rule blocking ~55 scraper/AI/HTTP-
    library UA fragments + empty UA on `/framework*` and `/api/framework*`.
  - Rollback: set `ai_bots_protection` back to `"disabled"` via
    `PUT /zones/493c65a139029245344eaa89daeb9820/bot_management`; delete the
    ruleset via the rulesets API.

Honest limits (stated to owner): a determined scraper running a full headless
browser with a spoofed UA defeats UA/JS gates; the layers stop HTTP-library
scrapers, AI crawlers (which also honor the robots/noai opt-outs), and
naive automation. The GitHub repo is PRIVATE (verified 2026-07-11), so the
in-repo `docs/trading-framework.md` is not an exposure surface today; if the
repo is ever made public, that doc becomes reachable regardless of site
hardening — revisit then.

## Why

Owner request 2026-07-11: "make a document explaining the trading related
framework (not user or account specific) of the entire app… make it available
online at socratictrade.com/framework… do whatever we can to harden the site
against AI or bots/systems trying to extract any information from it."

## Files

- `docs/trading-framework.md` (new)
- `app/framework/page.tsx` (new — UA-gated server shell)
- `app/framework/framework-viewer.tsx` (new — client fetch + render)
- `app/framework/framework-diagrams.tsx` (new — pipeline/stack/flywheel SVGs)
- `app/framework/content.ts` (new — server-only content module)
- `app/framework/ua-gate.ts` (new — shared UA blocklist)
- `app/api/framework/content/route.ts` (new — gated content API)
- `test/framework-page.test.ts` (new — 9 tests: UA gate, API gates/headers, content shape)
- `middleware.ts` (two lines: `/framework` + `/api/framework` in PUBLIC_PREFIXES)
- `app/robots.ts` (AI-crawler rules; /framework disallowed)
- `next.config.mjs` (headers() block for /framework)
- `.claude/launch.json` (new — dev-server launch config for the preview tool)
- `docs/EFFORT-LOG.md`, `STATUS.md`, `PLAN.md` (protocol updates)

## Verification

- Focused: `npx vitest run test/framework-page.test.ts` → 9/9 green (Node 24).
- `npx tsc --noEmit` clean after `NODE_AUTH_TOKEN=$(gh auth token) npm ci`
  (worktree node_modules predated main's shared-pkg v1.5.0 re-pin; the
  congress-analytics tsc error seen before reinstall was stale-deps, not code).
- Dev-server behavioral checks (curl):
  - `/framework` with curl/GPTBot UA → 404; Chrome UA → 200 shell.
  - Served HTML contains zero framework prose (grep for distinctive phrases → 0).
  - `/api/framework/content`: 404 without proof header; 404 for curl UA with
    header; 200 + noai/no-store/tdm headers for browser UA + header.
  - `robots.txt` renders per-AI-crawler disallow blocks.
- Browser (in-app pane): desktop + mobile (375px) render verified — content
  loads, all three diagrams render (vertical pipeline variant on mobile), no
  horizontal overflow. Found + fixed a real bug during this pass: the
  original double-`requestAnimationFrame` fetch gate never fires in
  render-throttled/background tabs, stranding the page on "Loading…" —
  replaced with `setTimeout` (rAF is throttled to zero in background tabs).
- Full ordered Node 24 gate (lint → tsc → full vitest → build): run after the
  fleet gate window cleared; results in STATUS.md.

## Live verification + follow-up fix (post-deploy, same day)

PR #1460 merged as `0f894d16`; auto-deploy verified live. Production checks:
curl default/GPTBot/python-requests UAs → **403 at the Cloudflare edge** (WAF
rule working); browser UA → 200 shell with zero framework prose in HTML;
noai/noindex + tdm-reservation + no-store headers present; content API 404s
without the proof header; /api/health ok on the new sha with the scheduler
ticking.

One live gap found: **production auth-gated `/robots.txt`, `/sitemap.xml`,
and `/manifest.webmanifest`** (307 → /login for anonymous requests —
pre-existing since the edge-auth rework, unnoticed because dev fails open).
A redirected robots.txt parses as "no rules," killing the robots/noai opt-out
layer for the whole site. Follow-up branch `claude/public-metadata-routes`
adds the three metadata paths to `PUBLIC_PREFIXES` plus a regression test in
`test/middleware-auth.test.ts` (auth armed → 200 for all three).

## Follow-ups / risks

- CODEX PR #1399 (`public-auth-rate-limit-hardening`) also touches
  `middleware.ts`; whichever lands second needs the trivial union (my change
  is two PUBLIC_PREFIXES lines).
- The WAF UA list and `ua-gate.ts` list are maintained separately (edge vs
  app) — keep in sync when adding crawlers.
- If the owner later wants the page indexable (SEO), the noindex layers are
  each independently reversible; today it is deliberately dark.
- If the repo is ever made public, reconsider how much of
  `docs/trading-framework.md` should live in-repo (see honest limits above).
