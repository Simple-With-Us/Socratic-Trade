import { ConSignedText } from "socratic-trade-dashboard";

export const DailyPL = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 220 }}>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>NVDA</span>
        <ConSignedText value={2.4}>+2.40%</ConSignedText>
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>TSLA</span>
        <ConSignedText value={-1.1}>-1.10%</ConSignedText>
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>SPY</span>
        <ConSignedText value={0}>0.00%</ConSignedText>
      </div>
    </div>
  </div>
);

export const AccountEquityChange = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span>Today</span>
      <ConSignedText value={1284.5}>+$1,284.50</ConSignedText>
    </div>
  </div>
);

export const RealizedLossOnClose = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span>Closed AMD</span>
      <ConSignedText value={-342.18}>-$342.18</ConSignedText>
    </div>
  </div>
);
