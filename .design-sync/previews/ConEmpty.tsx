import { ConEmpty } from "socratic-trade-dashboard";

export const NoPositions = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 360 }}>
    <ConEmpty>No open positions. Run the strategy loop or place a manual order to get started.</ConEmpty>
  </div>
);

export const NoAccountConnected = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 360 }}>
    <ConEmpty>No broker account connected — connect Alpaca or Robinhood to enable order submission.</ConEmpty>
  </div>
);
