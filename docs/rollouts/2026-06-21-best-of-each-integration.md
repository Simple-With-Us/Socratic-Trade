# 2026-06-21 — Best-of-each branch integration (`agent/claude` → `main`)

## Summary
Reconciled the parallel agent branches via a 7-agent comparison (see
`docs/reviews/2026-06-21-branch-reconciliation-best-of-each.md`), then landed the recommended
"best of each" onto `main` as surgical cherry-picks + one safe dependency bump. All verified.

## What was integrated (cherry-picked onto current main)
- **feat/tuner-missed-opportunities** `6fa51b5` (wholesale) — auto-tuner now feeds matured
  missed-opportunity counterfactuals (`src/lib/strategy-tuning.ts` + test). Conflict-free.
- **chore/safety-quick-wins** `877bb45` — SQLite `busy_timeout=5000` + `synchronous=NORMAL`,
  Bull/Bear `JSON.parse` guards, `confidenceScore` clamp (1–100), and a real bug fix
  (`.join("\\n")` → `.join("\n")` — the Bear prompt was being sent with a literal backslash-n).
- **safety-quick-wins backend** `d014842` — `AccountCapabilities` classifier + **two-layer short
  gate** (`!shortSellingEnabled || !brokerSupportsShort`, extends — does not replace — main's
  short/cover branches), broker classifiers (`robinhood.ts`/`alpaca.ts`), `capabilities` DB
  column + `parseCapabilities`, the IntegrationsSection capabilities badge, and **activated the
  CI workflows** (`ci-pending/` → `.github/workflows/{ci,e2e,security}.yml`). Includes the
  matching `test/policy.test.ts` rejection-string updates.
- **safety-quick-wins logos** `e5dd681` — **logo.dev cascade fallback** in
  `app/api/logos/ticker/route.ts` (extracted `fetchImage()`, gated on `LOGO_DEV_TOKEN`, monogram
  letter-badge fallback) + `src/lib/ticker-logos.ts` exports. **Complementary** to main's
  light-mode tile-contrast fix (`app/ui/ticker-logo.tsx` left untouched) — logo.dev's dark-theme
  PNGs sit on exactly that dark tile.
- **lucide-react `0.468 → 1.21.0`** (the one dependency adopted) — verified: all imported icons
  resolve; tsc/test/build clean.

## What was NOT taken (and why)
- **agent/antigravity header** — already merged to `main` (commit `4078cd5`) and the merger
  correctly preserved main's improvements: verified current `main` still has the iPad `lg:`
  cockpit shell, `min-h-16` header, both select `aria-label`s, the removed `executionTone()`,
  and Score at scan-column 2. No header work needed; the reconciliation's "do not wholesale-take
  4078cd5" trap did **not** materialize. (IPH-5 "header wraps on phones" remains a partial fix;
  the `…`-overflow popover is still deferred.)
- **agent/antigravity `connected-accounts` Alpaca baseUrl auto-default** — dropped (redundant
  with `alpaca.ts options.paper`; stale-URL maintenance hazard).
- **@types/node 26** — **held**: fails `tsc` (tightened `crypto.BinaryLike`/`ArrayBufferView`
  generics break `src/lib/market-signals/massive-s3.ts:40`). Per the plan's tsc gate.
- **eslint 10** — **held**: ERESOLVE peer conflict with `eslint-config-next@15` (which pins
  eslint ^8||^9). Low value (lint not in the verify trio).
- **zod 4, next 16** — **held**: majors needing dedicated migration (zod v4 generics; Next 16
  `next.config.ts` migration — `experimental.serverActions`/`turbopack`/custom webpack).
- **agent/codex** — nothing to take (a single self-labeled "DO NOT MERGE" doc). Branch deletion
  deferred (destructive op; not done without explicit per-branch confirmation).
- **a5f3079** (chore CI-activate) — redundant; `d014842` already moved `ci-pending/` →
  `.github/workflows/`.

## Verification
After the four cherry-picks: `npx tsc --noEmit` clean, `npm test` **404 passing (51 files)**,
`npm run build` green. After the lucide-react 1.21 bump: re-ran the trio — all green.

## Conflicts encountered
Only `STATUS.md` (additive Active-Focus entries) on `877bb45` and `d014842` — resolved by
keeping all sides. Code hunks (`db.ts`, `strategy.ts` across chore-safety + safety-backend)
auto-merged cleanly.

## Follow-ups
- next 16 + zod 4 migrations (separate PRs); @types/node 26 + eslint 10 once peers allow.
- IPH-5 header `…`-overflow popover (still deferred — see the issue register).
- Delete `agent/codex` (docs-only) after confirmation; CI workflows need a git token with the
  `workflow` OAuth scope to push.
