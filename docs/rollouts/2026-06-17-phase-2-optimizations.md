# 2026-06-17 Phase 2 Optimizations: Data Strategies, LLM Efficiency, and UI Polish

## Summary
Executed the Phase 2 optimization plan, shifting the burden of regime detection and candidate filtering from the LLM to the backend. The LLM payload was aggressively pruned by abstracting the allowlist and minifying Market Scan keys. Additionally, the cockpit UI was polished with interactive charts and a real-time toast notification system.

## Why
- **Strategic Evaluation**: The LLM is prone to hallucinating market regimes when given raw macroeconomic data. Deterministic backend regime calculation ensures consistency. Pre-filtering the Market Scan improves the signal-to-noise ratio.
- **Token Efficiency**: Sending the full allowlist and long JSON keys wastes hundreds of tokens per tick. Abstracting the allowlist to a silent backend guardrail significantly reduces prompt bloat.
- **UI/UX Polish**: Users needed the ability to zoom/pan historical P&L curves and required immediate feedback for trades without cluttering the main workspace.

## Files Touched
- `src/lib/macro.ts`: Implemented `determineMarketRegime` based on VIX thresholds.
- `src/lib/strategy.ts`: Applied Market Scan minification, backend pre-filtering (`score >= 40`), total allowlist abstraction, and injected the deterministic regime into the LLM payload. Removed `entryMarketRegime` from the required LLM JSON schema.
- `app/layout.tsx`: Wrapped the layout with `sonner` Toaster.
- `app/dashboard-client.tsx`: Replaced custom floating alerts with `sonner` toasts for `runStrategy`, `approveProposal`, etc. Implemented `next/dynamic` lazy loading for `recharts` components.
- `app/ui/charts.tsx`: Imported and applied the `Brush` component to the `EquityCurve` for zoom/pan.

## Verification
```bash
npx tsc --noEmit   # passed (fixed a few minor TS issues with deleted state vars)
npm test           # 118 passing tests
npm run build      # successful Next.js production build
```

## Follow-ups
- Explore adding real-time options flow data to the backend Market Scan pipeline.
- Consider adding an external natural language processing endpoint for 8-K sentiment analysis.
