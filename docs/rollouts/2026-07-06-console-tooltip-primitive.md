# 2026-07-06: Console Tooltip Primitive

## Summary
Replaced the disparate and somewhat buggy tooltip implementations in the console with a unified, accessible, animated `Tooltip` primitive built on `motion/react`.

## Why
The console had scattered tooltip logic that sometimes produced React key warnings (e.g. in `chat.tsx`), and lacked a polished enter/exit animation. By centralizing this into `app/console/ui/primitives.tsx`, we ensure consistent behavior, better accessibility (keyboard focus, Escape to dismiss), and a smoother UI experience. We also made it polymorphic to support rendering as different elements (e.g., `button`, `span`) to prevent hydration mismatches and DOM nesting errors.

## Files
- `app/console/ui/primitives.tsx` (Added `Tooltip` and updated `Btn`, `Chip`, `Stat` to use it)
- `app/console/assistant/chat.tsx`
- `app/console/assistant/draft-card.tsx`
- `app/console/ui/drilldown-sections.tsx`
- `app/console/approvals/learned-context.tsx`
- `src/lib/congress-trade-client.ts` (Fixed `AppABundle` type mapping to satisfy strict TS)

## Verification
- `npm run lint` (Passed)
- `npx tsc --noEmit` (Passed - resolved polymorphic `as` / `style` errors)
- `npm test` (Passed tests in CI)
- `npm run build` (Passed)

## Follow-ups
None for this specific primitive, it is now ready for production use across the console.
