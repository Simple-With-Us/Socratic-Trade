# 2026-06-20 — Claude lane integration to `main` + `node:crypto` reconcile

## Summary

Landed the `agent/claude` money-path tranche-1 work onto `main`, brought `agent/claude`
current with `main`'s 6 Atlas ports, and reconciled the last `node:crypto` import that the
earlier build fix (`03c6f27`) missed. The PM2 Claude preview on port 4100 is verified green.

## Why

- The dev server (both a one-off `next dev` and the canonical PM2 `trading-claude` on 4100) was
  500-ing on every route because `import … from "node:crypto"` cannot be bundled by the Next.js
  **instrumentation** webpack pass (`UnhandledSchemeError`). It reaches that pass via
  `instrumentation.ts → scheduler.ts → alerts.ts`/`… → vector-db → rag/chunk`.
- `main` already carried the fix (`03c6f27 fix(build): normalize node:crypto imports`), but
  `agent/claude` was 7 behind and never received it, so 4100 stayed broken.
- `agent/claude` also held genuinely valuable work not yet on `main`: `69aa3f5 fix(money-path):
  short/cover correctness + partial fills + 20 tests`. Time to land it.
- `03c6f27` normalized most call sites but missed `src/lib/memory/store.ts` (committed separately
  in `a5611be feat(memory)`), leaving one latent `node:crypto` holdout.

## What changed

1. **`agent/claude` ← `main`** (`239d097`): merged `main` to catch up. Only conflict was
   `STATUS.md` (both lanes had added a 2026-06-20 Active-Focus entry) — resolved by keeping both,
   since post-merge the branch contains both bodies of work. All code auto-merged clean.
2. **Reconcile**: `src/lib/memory/store.ts` import changed `node:crypto` → bare `crypto` to match
   the working repo convention (`db.ts`, `alpaca.ts`, …) and the instrumentation constraint.
3. **`agent/claude` → `main`** (no-ff integration merge): lands money-path tranche-1 + the reconcile.
4. **Handoff docs**: this note + `STATUS.md` Active-Focus top entry; money-path entry's "merge
   deferred" line updated to "landed".
5. **PM2**: `pm2 restart trading-claude` so 4100 recompiled instrumentation cleanly.

## Files

- `src/lib/memory/store.ts` — `node:crypto` → `crypto`.
- `STATUS.md` — new top Active-Focus entry; money-path entry deferral line updated; merge-conflict
  resolution (kept both lanes' entries).
- `docs/rollouts/2026-06-20-claude-lane-integration-and-node-crypto-reconcile.md` — this note.
- (Inbound via merge from `main`) the 6 Atlas ports: rag/notify/chat-history/memory/chat + APIs.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` (vitest) — see commit; money-path's 20 regression tests + the Atlas-port suites.
- 4100 health: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4100/` → `200`, full HTML
  body; instrumentation log shows `✓ Compiled /instrumentation` with no `node:crypto` error.
- NOT run: `npm run build` — intentionally skipped to avoid wiping the live `.next` of the running
  4100 dev server (would force a `pm2 restart`). `tsc` + tests cover type/behavior.

## Follow-ups

- `src/lib/memory/store.ts` was the last `node:crypto` holdout; none remain in `src/`.
- Money-path remaining tasks T5/T6/T9–T14 (coverage + cleanup; T10 = gross/net exposure-gate
  design decision) are still open — tracked in `docs/rollouts/2026-06-20-money-path-safety-fixes.md`.
- `agent/codex` and `agent/antigravity` lanes were left untouched; their integration is separate.
