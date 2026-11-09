# 2026-06-17 Optimizations: Kelly Sizing, Token Efficiency, and UI Virtualization

## Summary
Executed a series of optimizations spanning data strategy, LLM efficiency, and UI performance, based on brainstormed ideas from the recent AI implementation plan. The LLM now focuses purely on qualitative proposal generation, while sizing is deterministically handled by the backend using a Kelly-lite criteria based on historical win rates and LLM conviction. Payload efficiency and UI rendering speed were also significantly improved.

## Why
- **Sizing Reliability**: The LLM's raw dollar/quantity outputs are opaque and sometimes volatile. Relying on actual realized track records (`shrunkWinRate`) mapped against the LLM's conviction score provides a safer, deterministic sizing rule.
- **Token Efficiency**: Sending full portfolio states and verbose JSON keys (`tradeOutcomesByThesisRegime`) on every strategy run wastes tokens and bloats context windows.
- **UI Performance**: Displaying the full Market Scan allowlist (which can be 500+ symbols) crashed or stuttered the React component when iterating over heavy DOM nodes.

## Files Touched
- `src/lib/strategy.ts`: Added `applyDeterministicSizing()` to override proposal quantities/notionals based on win-rate and conviction. Implemented JSON key minification and Delta-Only portfolio state logic.
- `app/dashboard-client.tsx`: Imported `react-virtuoso` and refactored the `MarketScanView` table to use `<TableVirtuoso>`, allowing unlimited rows with smooth 60fps scrolling.

## Verification
```bash
npx tsc --noEmit   # passed (after fixing a minor useRef and type issue)
npm test           # 118 passing tests
npm run build      # successful production build
```

## Follow-ups
- Server-Sent Events (SSE) was deferred to avoid breaking existing Vercel deployment setups due to long-lived connections. The current 30-second polling loop remains.
- Consider exploring WebSockets if true real-time sub-second latency is required in the future.
