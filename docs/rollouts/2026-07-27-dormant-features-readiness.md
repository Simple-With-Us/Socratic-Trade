# 2026-07-27 — Dormant features readiness (CURSOR)

## Summary

Prepared remaining default-off / dormant capabilities so they can be **enabled safely** —
wiring, readiness inventory, docs — without blindly flipping rights-gated or high-cost flags.

## Why

Owner: “Work on the dormant features so they can be implemented.” After Priority A RAG
defaults went live (#2193), the backlog still mixed LIVE, ready-ops, and blocked items, and
docs still claimed landing pages were dormant/`LANDING_PAGE_ENABLED` → 404 (wrong since
2026-07-03). Operators also lacked a CSP report collector and a clean-text `embed_rev` bump
before flipping `VECTOR_EMBED_CLEAN_TEXT`.

## Files

- `src/lib/landing-page.ts` — unset/empty → ON; explicit off → hide
- `src/lib/dormant-features.ts` — env readiness checklist
- `src/lib/vector-db.ts` — `currentEmbedRev()` (1 normal, 2 when clean-text on)
- `app/welcome|how-it-works|strategy/page.tsx`, `app/sitemap.ts` — gate via `landingPageEnabled`
- `app/api/csp-report/route.ts` — public CSP report collector
- `middleware.ts` — public path + default policy `report-uri /api/csp-report`
- `app/api/admin/rag-coverage/route.ts` — `dormantFeatures` payload
- `.env.example` — LANDING / CSP / clean-text comments
- `docs/FEATURE-ENABLEMENT-BACKLOG.md` — Ready / Keep-off / Live rewrite
- `docs/EFFORT-LOG.md`, `STATUS.md`, `PLAN.md`, this note
- Tests: `test/dormant-features.test.ts`, `test/csp-report.test.ts`, security-headers + clean-text

## Intentional non-flips

Keep OFF unless owner decides: MULTIQUERY/HyDE, `VECTOR_ASOF_STRICT`, FMP transcript dual-gate,
SEC8K full body, SEC ingest worker always-on, candidate-pool FULL, legacy purge.

Ready-but-ops (Infisical flip): `CSP_ENABLED=on` (report-only), `USAGE_BUDGET_ENFORCE`,
`RAG_EMBED_DISCLOSURES`, `RAG_PERSIST_CANDIDATE_POOL` canaries, `VECTOR_EMBED_CLEAN_TEXT`.

## Verification

```bash
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npx vitest run test/dormant-features.test.ts test/csp-report.test.ts \
  test/security-headers.test.ts test/vector-db-staleness-and-clean-text.test.ts
                      # 4 files / 27 tests green
npm run build         # clean (includes /api/csp-report, /welcome, /how-it-works, /strategy)
```

Full `npm test` in this Cloud VM is polluted by injected Runtime Secrets
(Voyage/OpenRouter/SiliconFlow/Tradier/etc.) and Bearer scrubbing (`Bearer [REDACTED]`),
which fail unrelated provider-routing / auth-header assertions. Hosted `verify` CI
(no those secrets) is the merge gate.

## Follow-ups

- Prod Infisical: optional `CSP_ENABLED=on` canary; do not set `CSP_REPORT_ONLY=off` yet.
- Clean-text: enable only with reindex/backfill plan; never purge `embed_rev=1` early.
- Residual Planned enablement stays on the FEATURE-ENABLEMENT backlog + effort board.
