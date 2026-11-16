# 2026-07-22 — UI Redesign: Proposal Slide-out Drawer and Inline Approval

## Summary
Replaced the "Market Thesis" hero and autonomous actions feed with a unified Strategy Run summary and mapped proposal feed in `app/console/page.tsx`. Each proposal is now a clickable row that opens a slide-out drawer containing its full `ThesisNarrative` and `Evidence`. Pending proposals can be approved inline directly from the drawer. 

## Why
User requested removing the singular "Market Thesis" focus that misrepresented the app's scope. The new design surfaces all proposals generated in a run, provides detailed reasoning via drawers without cluttering the main feed, and enables quick inline approval for pending trades without navigating to the approvals tab.

## Files Touched
- `app/console/page.tsx`: Replaced `actionRows` mapping with `ProposalRow` component. Implemented `Sheet` drawer, integrated `ThesisNarrative` and `EvidenceCard`, and added `approveProposal` mutation logic.

## Verification
```bash
npm run lint       # 0 errors
npx tsc --noEmit   # clean
npm test           # 4,901 tests passing
npm run build      # clean Next.js build
```

## Follow-ups
- Check UI design rendering in browser to make sure the drawer behavior feels right.
