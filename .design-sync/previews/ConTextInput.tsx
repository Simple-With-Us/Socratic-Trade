import { ConTextInput } from "socratic-trade-dashboard";

export const ThesisTag = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextInput defaultValue="earnings-beat-momentum" placeholder="e.g. earnings-beat-momentum" />
  </div>
);

export const SymbolSearch = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextInput placeholder="Search symbol (e.g. NVDA)" />
  </div>
);

export const OrderNote = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextInput defaultValue="Trimming into strength, half position" />
  </div>
);

export const DisabledAccountLabel = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextInput defaultValue="Alpaca — Main Brokerage" disabled />
  </div>
);
