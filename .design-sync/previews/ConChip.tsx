import { ConChip } from "socratic-trade-dashboard";

export const Tones = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
    <ConChip tone="muted">WATCHLIST</ConChip>
    <ConChip tone="accent">RESEARCH</ConChip>
    <ConChip tone="pos">+2.4%</ConChip>
    <ConChip tone="neg">-1.8%</ConChip>
    <ConChip tone="warn">AT RISK</ConChip>
    <ConChip tone="none">NONE</ConChip>
    <ConChip tone="paper">PAPER</ConChip>
    <ConChip tone="live">LIVE</ConChip>
  </div>
);

export const InContext = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>NVDA</span>
      <ConChip tone="pos">+3.1%</ConChip>
      <ConChip tone="accent">CORE</ConChip>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>Alpaca — Main</span>
      <ConChip tone="live" title="Trading with real capital">LIVE</ConChip>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>Alpaca — Sandbox</span>
      <ConChip tone="paper" title="Simulated fills, no real capital">PAPER</ConChip>
    </div>
  </div>
);
