import { ConNumInput } from "socratic-trade-dashboard";

export const OrderSize = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConNumInput defaultValue={25} placeholder="0" />
  </div>
);

export const LimitPrice = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConNumInput defaultValue={150.25} step={0.01} placeholder="0.00" />
  </div>
);

export const MaxPositionPct = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConNumInput defaultValue={5} placeholder="0" />
  </div>
);

export const DisabledStopLoss = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConNumInput defaultValue={142.1} disabled />
  </div>
);
