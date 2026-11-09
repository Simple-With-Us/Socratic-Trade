import { ConStat } from "socratic-trade-dashboard";

export const PL = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", gap: 24, flexWrap: "wrap" }}>
    <ConStat label="Day P/L" value="+$1,284.50" sub="+2.6% of NAV" tone="pos" />
    <ConStat label="Open P/L" value="-$342.10" sub="-0.9% of NAV" tone="neg" title="Unrealized across 6 positions" />
  </div>
);

export const PortfolioSummary = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", gap: 24, flexWrap: "wrap" }}>
    <ConStat label="Net Liquidation" value="$48,912.33" sub="as of 3:58pm ET" />
    <ConStat label="Buying Power" value="$21,004.10" />
    <ConStat label="Win Rate (30d)" value="63%" sub="19 of 30 trades" tone="pos" />
  </div>
);
