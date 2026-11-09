# 2026-06-20 - project-rename-alignment

## Summary

- Aligned the overall dashboard and repository documentation titles to broker-neutral dashboard wording.
- Updated `PLAN.md` to avoid the prior Robinhood-prefixed dashboard title.

## Why

- As the application now supports multiple brokers (Alpaca and Robinhood) and broker-neutral setups, it should avoid Robinhood-prefixed product naming.

## Files

- `PLAN.md`
- `STATUS.md`

## Verification

- Run `npx tsc --noEmit`
- Run `npm test` (all 287 tests succeeded)
- Run `npm run build` (Next.js production compilation completed successfully)

## Follow-ups

- None
