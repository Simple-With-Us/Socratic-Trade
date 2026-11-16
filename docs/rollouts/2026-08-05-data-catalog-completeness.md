# 2026-08-05 — Data catalog, RAG/numeric completeness, field→sources admin

## Context & Objective

Owner needs (1) confirmation RAG is presented to the LLM, (2) **completeness %** for
RAG and other non-numeric data (partial when some tickers lack 10-Ks; extra 10-Ks on
one name must not fake 100%), (3) provenance stamps on all data, (4) an index of every
data kind and **possible** sources (with notes), (5) an admin UI for agents/humans to
see cascade shortfalls.

## Answer: is RAG per ticker sent to the LLM?

**Yes, but bounded.** Strategy retrieves filings/transcripts into
`retrievedFinancialContext` (deep ~8 chunks for top-3 candidates + held names; scout
~1 for other scan symbols). It is **not** a full-corpus dump. Structured scan fields
are separate compact keys; missing values are **omitted**, not blank strings.

## Changes Made

- `src/lib/data-catalog.ts` — static inventory of fields + sources (active/scarce/retired/keyless/peer/computed) with notes and LLM keys.
- `src/lib/data-completeness.ts` — live completeness:
  - Numerical: durable `symbol_field_latest` fill rate (fallback cascade report).
  - RAG: share of universe with ≥1 accession per doc type; per-ticker partial = doc types present / 4 expected; **capped at 1.0 per type per ticker**.
- `GET /api/admin/data-catalog` — catalog + completeness JSON.
- `/admin/data-catalog` — expandable field drawers (sources table + status + notes), overall/numerical/RAG % stats, weakest tickers, source registry.
- Admin nav entry.

## Verification

```bash
npx tsc --noEmit
npx vitest run test/data-catalog-completeness.test.ts
```

## Next steps

- Pin completeness universe to policy scan universe when policy is available in admin request context.
- Wire Scan banner link → this page.
- Extend catalog macro fields when needed.
