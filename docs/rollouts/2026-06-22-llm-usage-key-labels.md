# 2026-06-22 - llm-usage-key-labels

## Summary

Made the per-attached-key LLM usage view human-readable. The ledger stores only an opaque
fingerprint (`key_ref`); `describeUsageKey(row)` (new, in `src/lib/llm-usage.ts`) now maps that
fingerprint back to a **last-4 + label** by matching it against the LIVE key store at read time:

- a user's own key → `{ last4, label: "<userId> (<provider>)" }`,
- the `local` primary user → `label: "operator (<provider>)"`,
- a tenant served by the operator env failover → `label: "operator env (<provider>)"`,
- a detached/unknown key → `undefined` (the ledger keeps the fingerprint; the label is only
  available while the key is still attached).

`GET /api/admin/llm-usage` now enriches each per-key row with `keyLabel` + `keyLast4`.

## Why

Follow-up flagged at the end of the per-key-ledger work (PR #73): the per-key view was an opaque
fingerprint. Owner approved adding a friendly label. The last-4 is a standard safe display
convention (Stripe/AWS/cards), is computed at read time, and is **never persisted** — no new secret
storage; the durable ledger still only holds the non-reversible fingerprint.

## Files

- `src/lib/llm-usage.ts` — `KeyDescriptor`, `describeUsageKey`; import `getUserApiKey` / `apiKeyEnvVarForService` / `LOCAL_USER`.
- `app/api/admin/llm-usage/route.ts` — enrich rows with `keyLabel` + `keyLast4`.
- `test/key-resolution-tiering.test.ts` — `describeUsageKey` cases (own/local/operator-env/detached).

## Verification

In `~/apps/trading-keys3` (branch `feat/llm-usage-key-labels`, base `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — **788 passed** across 85 files (+1).
- `npm run build` — clean (exit 0).

## Follow-ups

- None. (Labels resolve only while a key is attached, by design — a detached key keeps its
  fingerprint in the ledger but shows no label.)

## Blockers

- None.
