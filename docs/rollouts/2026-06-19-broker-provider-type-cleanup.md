# 2026-06-19 - broker-provider-type-cleanup

## Summary

- Tightened broker/provider parsing around Alpaca, Robinhood, OpenAI response helpers, and enrichment-provider payloads.
- Replaced broad untyped payload handling with `Record<string, unknown>` style parsing in the touched broker/provider paths.
- Preserved missing optional broker fields as `undefined` instead of leaking `NaN`, empty strings, or `"undefined"` into dashboard-facing data.
- Ignored `.air/` editor settings so local editor state does not get swept into repo commits.

## Why

The late cleanup pass reduced production risk in boundary code that consumes external API payloads. These adapters should degrade missing upstream fields to absent values, not fabricated numeric/string values that look real in downstream UI or risk checks.

## Files

- `.gitignore`
- `src/lib/alpaca.ts`
- `src/lib/data-providers.ts`
- `src/lib/db.ts`
- `src/lib/post-mortem.ts`
- `src/lib/red-team.ts`
- `src/lib/robinhood.ts`
- `src/lib/types.ts`
- `STATUS.md`
- `docs/rollouts/2026-06-19-broker-provider-type-cleanup.md`

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 223 tests across 30 files.
- `npm run build` - passed.

## Follow-ups

- Continue removing loose boundary typing opportunistically when touching provider adapters, but keep the behavior of missing upstream data as absent/unknown rather than synthetic.

## Blockers

- None.
