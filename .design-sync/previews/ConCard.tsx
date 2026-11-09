import { ConCard, ConChip, ConBtn, ConStat } from "socratic-trade-dashboard";

export const PositionsPanel = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 420 }}>
    <ConCard
      title="Open Positions"
      action={<ConChip tone="live">LIVE</ConChip>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600 }}>NVDA</span>
          <span>40 sh · +$612.40</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600 }}>AAPL</span>
          <span>25 sh · -$88.10</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600 }}>MSFT</span>
          <span>15 sh · +$204.75</span>
        </div>
      </div>
    </ConCard>
  </div>
);

export const StrategySummaryPanel = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 420 }}>
    <ConCard title="Strategy Loop" action={<ConBtn variant="outline" size="sm">Run once</ConBtn>}>
      <div style={{ display: "flex", gap: 20 }}>
        <ConStat label="Day P/L" value="+$1,284.50" tone="pos" />
        <ConStat label="Open Proposals" value="3" />
      </div>
    </ConCard>
  </div>
);

export const UnpaddedPanel = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 420 }}>
    <ConCard title="Recent Fills" padded={false}>
      <table className="con-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>TSLA</td>
            <td>Sell</td>
            <td>60</td>
          </tr>
          <tr>
            <td>AMD</td>
            <td>Buy</td>
            <td>30</td>
          </tr>
        </tbody>
      </table>
    </ConCard>
  </div>
);
