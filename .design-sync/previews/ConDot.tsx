import { ConDot } from "socratic-trade-dashboard";

export const Statuses = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="pos" />
      <span>Filled — AAPL 40 sh @ 231.10</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="neg" />
      <span>Rejected — insufficient buying power</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="warn" />
      <span>Partial fill — 12 / 25 sh</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="accent" />
      <span>Working — limit order queued</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="muted" />
      <span>No position</span>
    </div>
  </div>
);

export const Pulsing = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="accent" pulse />
      <span>Strategy loop running — evaluating MSFT</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConDot tone="pos" pulse />
      <span>Live market data streaming</span>
    </div>
  </div>
);
