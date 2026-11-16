# 2026-08-20 — Stale hosting / stack copy sweep

## Context & Objective

Jay asked for a docs/metadata sweep of current-truth hosting and stack copy
(Vercel, Cloudflare Workers, PWA-as-current, retired preview hosts, old product
subtitles).  Production is Coolify at socratictrade.com.  The `/mobile` PWA UI
was retired in #2801.  Do not change product code.

## Changes Made

README on `main` already says Coolify + socratictrade.com — left it alone.
GitHub About already says `Production: socratictrade.com` with homepage
`https://socratictrade.com` and does not mention Vercel, Workers, or PWA — left
it alone.

Fixed present-tense current-truth that still contradicted production:

- PLAN.md "Current Status" hosting topology still said Mac
  `~/apps/trading-live` / pm2 `trading` / port `4000` plus live
  `trading-beta.jays.services`.
- PLAN.md acceptance checks still required a production/beta hostname split
  and listed Mobile/PWA as a current client.
- PLAN.md phase-11 table still treated `/mobile` PWA as a live foundation
  (footnote added; table cells left as the June record).
- AGENTS.md still documented `cursor.jays.services` port 4103 as a current
  Cursor preview, pointed agents at PM2 worktree previews, listed PWA as a
  current copy surface, and told Cloud ops to `pm2 restart trading`.
- `.cursor/rules/ops-diagnostics.mdc` still named retired
  `trading.jays.services` as production and Mac `pm2 trading` as the restart.
- `docs/ops-observability-security.md` still described Litestream as a Mac PM2
  sidecar, Playwright vs a Codex PM2 preview, and gitleaks on a self-hosted
  runner.
- `docs/litestream.md` Setup still read as the production how-to (Mac PM2).
- `docs/design/ux-improvement-program.md` Goal still listed Phone PWA as a
  current surface.

Historical rollouts and STATUS entries that correctly describe past Vercel /
preview / PWA work were left as dated archive.

Touched files:

- `PLAN.md`
- `STATUS.md`
- `AGENTS.md` (`CLAUDE.md` symlink)
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-stale-hosting-docs.md`
- `.cursor/rules/ops-diagnostics.mdc`
- `docs/ops-observability-security.md`
- `docs/litestream.md`
- `docs/design/ux-improvement-program.md`

## Decisions & Trade-offs

- Did not rewrite historical rollouts (`2026-06-17-optimizations.md` SSE/Vercel
  rationale, July preview-retirement notes, August PWA-delete notes).  Those
  are dated records, not current topology.
- Did not edit GitHub About.  Description and homepage already match README.
- Did not touch product code (`next.config.mjs` Vercel cron comment,
  `VERCEL_GIT_COMMIT_SHA` env fallbacks, `app/manifest.ts`).
- Did not expand into Test-mode leftovers in the giant phase-11 table cells
  beyond the PWA/hosting footnote.

## Verification State

```bash
rg -n "cursor\\.jays\\.services|trading\\.jays\\.services" PLAN.md AGENTS.md .cursor/rules/ops-diagnostics.mdc
```

- `npx tsc --noEmit` / `npm test` / `npm run build` not required for this
  docs-only copy fix; lint still run if the environment has node_modules.
- GitHub About checked via `gh repo view --json description,homepageUrl`.

## Next Steps & Blockers

None.  Merge is docs-only.  Coolify `watch_paths` omits `docs/**`,
`STATUS.md`, and `PLAN.md` — this should not rebuild production.  `AGENTS.md`
and `.cursor/rules/` are outside that omit list; confirm Coolify does not
treat those as a deploy trigger.

## Zero-Code Findings

- GitHub About: `Agentic trading console for Alpaca, Tradier, and Robinhood —
  real broker paper/sandbox and live accounts. Production: socratictrade.com`
  / homepage `https://socratictrade.com`.  Not stale.
- README hosting paragraph already current.  Kept.
- `docs/deployment.md` and `docs/mobile-api-and-clients.md` already current.
- Atlas / settings-redesign / dated reviews that mention Vercel as a
  third-party pattern or as July 2026 CT Workers history were left alone.
