1. **Context & Objective**: The user requested that the "Previous Trades" rows on the console dashboard be reformatted onto a single line to improve scannability and aesthetics. Instead of stacking the verb, status chip, and "View details" link vertically, they should all be combined into a single, cohesive chip on one line.
2. **Changes Made**:
   - Replaced `.con-decision-row` with native Tailwind flex classes (`flex items-center justify-between`) in `ProposalRow` in `app/console/page.tsx` to force a single-line layout even on mobile.
   - Combined the trade action verb ("Buy", "Sell", "Bought", "Sold") and the deterministic decision status ("Pending", "Blocked", "Not placed") into a single, unified string (e.g. "Buy Blocked", "Sale Pending", "Bought").
   - Removed the separate "not placed" string and combined it into the single `Chip`.
3. **Decisions & Trade-offs**: The CSS class `con-decision-row` used a grid layout that broke into a vertical stack on mobile (`grid-template-columns: 1fr`). By replacing it with inline flex classes, the row stays consistently on one line, matching the user's explicit request. The combined status string handles grammar appropriately (e.g. "Sale Pending" instead of "Sell Pending").
4. **Verification State**: 
   - `npx tsc --noEmit`
   - `npm run lint`
   - `npm test`
   - `npm run build`
5. **Next Steps & Blockers**: None.
