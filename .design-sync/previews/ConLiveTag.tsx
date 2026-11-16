import { ConLiveTag } from "socratic-trade-dashboard";

export const InlineWithAccount = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>Alpaca — Main Brokerage</span>
      <ConLiveTag />
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>Robinhood — Retirement</span>
      <ConLiveTag />
    </div>
  </div>
);

export const NextToConfirmAction = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span>Submit sell order for 60 sh TSLA</span>
      <ConLiveTag />
    </div>
  </div>
);
