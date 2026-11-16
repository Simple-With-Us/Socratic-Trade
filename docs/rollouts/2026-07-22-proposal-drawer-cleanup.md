# 2026-07-22 — UI Redesign: Layout Cleanup & Proposal Drawer

## Summary
Completed the second phase of the UI redesign for `app/console/page.tsx` following the UI Expert teardown. Removed the old "Market Thesis" hero layout, restricted the top-level "Evidence" and "Dissent" sections to only render inside the `ProposalDrawer`, and successfully moved the "Autonomous Actions" list to the bottom of the page, renaming it to "Previous Trades".

## Why
The previous changes implemented the drawer but failed to clean up the page layout around it, leading to redundant evidence blocks and a cluttered top-feed. This update enforces a strict split: high-level summaries on the main page, and deep reasoning/evidence isolated strictly within the drawer.

## Files Touched
- `app/console/page.tsx`: 
  - Restructured `DecisionRowData` to carry the underlying proposal objects.
  - Split `actionRows` into `latestProposals` and `previousTrades`.
  - Deleted top-level Evidence, Dissent, and Hero cards.
  - Reordered the `ConsoleHomePage` layout to push historical actions to the bottom.

## Verification
```bash
npm run lint       # 0 errors
npx tsc --noEmit   # clean
npm test           # 5,204 tests passing
npm run build      # clean Next.js build
```

## Follow-ups
- Check UI design rendering in browser to make sure the drawer behavior feels right.
