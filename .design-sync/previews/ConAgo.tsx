import { ConAgo } from "socratic-trade-dashboard";

export const RecentFills = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 220 }}>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>Last fill</span>
        <ConAgo iso="2024-05-15T11:52:00Z" />
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>Policy sync</span>
        <ConAgo iso="2024-05-15T05:10:00Z" />
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
        <span>Broker connected</span>
        <ConAgo iso="2024-03-02T00:00:00Z" />
      </div>
    </div>
  </div>
);

export const MissingTimestamp = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", gap: 12, justifyContent: "space-between", maxWidth: 220 }}>
      <span>Last rebalance</span>
      <ConAgo iso={null} />
    </div>
  </div>
);
