import { ConMeter } from "socratic-trade-dashboard";

export const DayLossLimit = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 14, minWidth: 260 }}>
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span>Day-loss limit used</span>
        <span>$180 / $2,000</span>
      </div>
      <ConMeter value={180} max={2000} />
    </div>
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span>Day-loss limit used</span>
        <span>$1,540 / $2,000</span>
      </div>
      <ConMeter value={1540} max={2000} />
    </div>
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span>Day-loss limit used</span>
        <span>$1,960 / $2,000</span>
      </div>
      <ConMeter value={1960} max={2000} />
    </div>
  </div>
);

export const BuyingPowerUsage = () => (
  <div className="console-root" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 14, minWidth: 260 }}>
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span>Buying power deployed</span>
        <span>$4,200 / $25,000</span>
      </div>
      <ConMeter value={4200} max={25000} />
    </div>
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span>Position size vs. max</span>
        <span>no cap set</span>
      </div>
      <ConMeter value={500} />
    </div>
  </div>
);
