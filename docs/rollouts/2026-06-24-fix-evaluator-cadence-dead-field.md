# 2026-06-24 — Remove dead `evaluatorCadenceHours` policy field

## Summary
Removed `evaluatorCadenceHours` from `TradingPolicy`. It was a dangling cadence
control: declared on the type and accepted in the strategy-tuner patch-keys
union, so the policy API would accept and persist it — but **nothing in the app
ever read it**. A user (or the LLM tuner) could set an "evaluator cadence (hours)"
and observe no behavior change.

## Why
Flagged as a pre-existing issue in `docs/rollouts/2026-06-24-safety-fixes-a-e.md`
("`evaluatorCadenceHours` is a dangling policy field (no reader)"). The owner
asked to fix the "cadence hours issue." A persisted-but-ignored control is a
footgun (implies functionality that doesn't exist), so the fix is to remove it.
There is no separate "evaluator" run loop in the codebase — the only `evaluator`
symbol is the unrelated price-events signal evaluator in
`src/lib/streams/alpaca-price-events-stream.ts`. Real, wired cadence controls are
unaffected: `runCadenceMinutes` (scheduler) and `proposalRevalidateCadenceHours`
(on-run LLM re-validation).

## Files
- `src/lib/types.ts` — removed the `evaluatorCadenceHours?: number;` field
  declaration and removed `"evaluatorCadenceHours"` from the tuner patch-keys
  `Pick<TradingPolicy, ...>` union.
- `STATUS.md` — Active Focus entry.
- `docs/rollouts/2026-06-24-fix-evaluator-cadence-dead-field.md` — this note.

## Migration / compatibility
None needed. The field was never in `DEFAULT_POLICY`, never validated in
`app/api/policy/route.ts`, and had no UI control. Any already-persisted policy
JSON that happens to carry the key is harmless — `mergePolicy` only reads known
fields, so the extra key is ignored on load.

## Verification (commands actually run)
- `grep -rn "evaluatorCadenceHours" src/ app/ test/` → no matches after edit.
- `npx tsc --noEmit` → clean.
- `npm test` → 1061/1062 pass (only the pre-existing date-sensitive
  `cache-provenance` flake fails — unrelated).
- `npm run build` → green.

## Follow-ups
- Separate from this fix, a read-only audit ran this session for **silent
  free-tier capacity caps** and **other dead controls**. Headline items (NOT
  fixed here, surfaced to the owner in chat):
  - `vector-db.ts` Voyage embeddings: 21s batch delay (free-tier 3 RPM) — bulk
    backfill is very slow; paid tier removes it via `VECTOR_EMBED_BATCH_DELAY_MS=0`.
  - `web-sources/sec-filings.ts` filing-body ingest: ~1 filing/tick on free tier,
    weekly cadence.
  - `data-providers.ts` scan enrichment capped to top ~30 candidates.
  - `streams/alpaca-price-events-stream.ts` free IEX feed: silently drops watched
    symbols beyond 30 (warn-log only, no UI surface).
  These are mostly intentional/config-or-paid-tier, but several are silent and
  worth surfacing in the UI. No code changed for them yet.
</content>
</invoke>
