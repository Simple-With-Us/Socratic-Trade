# 2026-06-20 — Money-path plan merge gate: agent/claude → main

## Summary

All 14 money-path safety tasks verified and merged. `agent/claude` was 4 ahead / 4 behind
`origin/main`; merged cleanly (the 4 behind commits were the AI assistant tab feature from
a parallel fleet session). One pre-existing TS error was fixed inline during the merge gate.

## What was verified (on combined agent/claude ∪ origin/main tree)

- `npx tsc --noEmit` — one error found and fixed: `macro-panel.tsx:98` passed `up: boolean` to
  `Sparkline` but the component expects `colorClass: string`. Fixed by deriving `toneCls` from
  `polarity` field (matching the intent of the existing polarity logic in the same function).
- `npm test` — **386 tests passed** (49 test files).
- `npm run build` — **clean** (all routes compiled, no type or lint errors).

## Tasks merged

| Task | Description | Commit |
|------|-------------|--------|
| T1 | Side-aware per-symbol notional cap | `69aa3f5` |
| T2 | Partial-fill reconciliation (idempotent) | `69aa3f5` |
| T3 | Side-aware FIFO lot matcher | `69aa3f5` |
| T5 | Paper-projection side-aware guards | `9bf7848` |
| T6 | DB notional tests + null-notional fallback | `956d4a1` |
| T8 | Short protective exits (proactive + synthetic) | `69aa3f5` |
| T9 | `recordFillFromProposal` short/cover tests | `956d4a1` |
| T10 | Gross/net exposure gates enforced | `da644b6` |
| T11 | Red-team fail-open tests | `956d4a1` |
| T12 | Tax long-only pin (guard tests) | `956d4a1` |
| T13 | Explicit daily-reset timezone | `956d4a1` |
| T14-policy | Opens-only dailyNotionalUsed; dead helper removed | `da644b6` |
| T14-db | empty `account_number` → `__unassigned__` sentinel | `f790c9f` |

## Files touched in merge gate

- `app/ui/macro-panel.tsx` — TS fix: `up={up}` → `colorClass={toneCls}`

## Follow-ups (user-approved, not yet implemented)

1. **Gross/net caps in Settings UI** — `maxGrossExposurePct` and `maxNetExposurePct` are enforced
   in `policy.ts` but have no UI inputs. Add to the risk settings section in
   `app/ui/dashboard/settings.tsx` so users can configure based on their risk tolerance.
2. **Signed `OpenLot.quantity`** — currently positive magnitude + `side:"short"` flag. Should use
   negative quantity for shorts (aligning with `EquityPosition`). Change in `performance.ts`
   `calculatePnl`'s openLot construction; blast radius small (tax UI uses a separate `tax.openLots`).

## Verification commands

```bash
npx tsc --noEmit   # clean
npm test           # 386 passed
npm run build      # clean
```
