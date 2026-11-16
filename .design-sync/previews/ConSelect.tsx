import { ConSelect } from "socratic-trade-dashboard";

export const ExecutionAccount = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConSelect defaultValue="alpaca-main">
      <option value="alpaca-main">Alpaca — Main Brokerage</option>
      <option value="alpaca-sandbox">Alpaca — Sandbox</option>
      <option value="robinhood-retirement">Robinhood — Retirement</option>
    </ConSelect>
  </div>
);

export const OrderSide = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConSelect defaultValue="sell">
      <option value="buy">Buy</option>
      <option value="sell">Sell</option>
      <option value="short">Short</option>
      <option value="cover">Cover</option>
    </ConSelect>
  </div>
);

export const RebalanceHorizon = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConSelect defaultValue="30d">
      <option value="5d">5 trading days</option>
      <option value="30d">30 trading days</option>
      <option value="90d">90 trading days</option>
    </ConSelect>
  </div>
);

export const DisabledEnvironment = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConSelect defaultValue="live" disabled>
      <option value="paper">Paper</option>
      <option value="live">Live</option>
    </ConSelect>
  </div>
);
