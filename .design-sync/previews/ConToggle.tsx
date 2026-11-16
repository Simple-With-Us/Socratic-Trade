import { ConToggle } from "socratic-trade-dashboard";

export const AutoApproveEnabled = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConToggle checked={true} onChange={() => {}} label="Auto-approve low-risk" />
      <span>Auto-approve low-risk</span>
    </div>
  </div>
);

export const AutoApproveDisabled = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConToggle checked={false} onChange={() => {}} label="Auto-approve low-risk" />
      <span>Auto-approve low-risk</span>
    </div>
  </div>
);

export const LiveTradingEnabled = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConToggle checked={true} onChange={() => {}} label="Route to live broker" />
      <span>Route to live broker</span>
    </div>
  </div>
);

export const DisabledToggle = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <ConToggle checked={true} onChange={() => {}} disabled label="Wash-sale guard (locked)" />
      <span>Wash-sale guard (locked)</span>
    </div>
  </div>
);
